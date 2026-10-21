const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const webpush = require('web-push');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');
const { mintAccessTokenFromRefreshToken } = require('./lib/driveAuth');

const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');
const VAPID_PUBLIC_KEY = defineSecret('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');

// v2.145 — Notificaciones push (Web Push). Una sola función con varias
// acciones (un solo alta de invoker público en Cloud Run):
//   - key:         devuelve la clave pública VAPID (la necesita el navegador
//                  para suscribirse). No requiere sesión.
//   - subscribe:   guarda la suscripción de ESTE dispositivo para la cuenta.
//   - unsubscribe: la borra.
//   - status:      dice si este endpoint ya está suscripto a esta cuenta.
//   - notify:      alguien agregó fotos/videos o escribió una nota en un
//                  álbum; avisa a las demás personas con acceso al álbum.
//
// Quién recibe un aviso de notify (siempre sin el que hizo el cambio):
//   la dueña (shared_album_owner), los contribuidores (shared_album_members)
//   y los invitados Lector/Editor, que se resuelven EN VIVO contra los
//   permisos reales de la carpeta (token de la dueña), igual que el proxy de
//   álbumes compartidos: si una persona ya no tiene acceso, no recibe nada.
//   Si no se puede verificar (la dueña no tiene refresh_token guardado), los
//   invitados Lector/Editor se omiten (fail-closed), nunca se avisa a ciegas.
//
// Si el álbum nunca se compartió (no hay fila en shared_album_owner) no hay a
// quién avisar y se responde enseguida sin hacer más consultas.
const THROTTLE_MS = 2 * 60 * 1000;
const MAX_NAME = 80;
const KINDS = new Set(['photo', 'note']);

function clean(str, max) {
  return String(str || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function buildMessage({ kind, count, actorName, albumName }) {
  const who = clean(actorName, 40).split(/\s+/)[0] || 'Alguien';
  // El nombre del álbum va de título (los títulos se ven en negrita); sin nombre, "Legado".
  const title = albumName || 'Legado';
  if (kind === 'note') return { title, body: `${who} comentó una foto` };
  const n = Math.max(1, Math.min(count || 1, 999));
  return { title, body: `${who} agregó ${n === 1 ? 'una foto o video' : n + ' fotos y videos'}` };
}

async function listGuestEmails(supabase, ownerSub, folderDriveId) {
  const { data: row } = await supabase.from('subscriptions').select('drive_refresh_token').eq('google_sub', ownerSub).maybeSingle();
  if (!row || !row.drive_refresh_token) return null;
  const { accessToken } = await mintAccessTokenFromRefreshToken(row.drive_refresh_token, GOOGLE_CLIENT_ID.value(), GOOGLE_CLIENT_SECRET.value());
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderDriveId)}/permissions?fields=permissions(emailAddress,role,type)&pageSize=100`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const body = await r.json();
  return (body.permissions || [])
    .filter(p => p.type === 'user' && p.role !== 'owner' && p.emailAddress)
    .map(p => p.emailAddress.toLowerCase());
}

async function handleNotify(req, res, supabase, session) {
  const { folderDriveId, kind, count, albumName } = req.body || {};
  if (!folderDriveId || typeof folderDriveId !== 'string' || !KINDS.has(kind)) {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  const { data: ownerRow } = await supabase.from('shared_album_owner').select('owner_google_sub').eq('folder_drive_id', folderDriveId).maybeSingle();
  if (!ownerRow) { res.status(200).json({ ok: true, sent: 0, reason: 'not_shared' }); return; }
  const ownerSub = ownerRow.owner_google_sub;

  const { data: members } = await supabase.from('shared_album_members').select('guest_google_sub').eq('folder_drive_id', folderDriveId);
  const memberSubs = (members || []).map(m => m.guest_google_sub);

  let guestEmails = null;
  try { guestEmails = await listGuestEmails(supabase, ownerSub, folderDriveId); } catch (e) { console.error('push guests error:', e && e.message); }
  const sessionEmail = (session.email || '').toLowerCase();

  // El que dispara tiene que tener acceso real al álbum: es la dueña, un
  // contribuidor, o figura entre los permisos reales de la carpeta.
  const actorAllowed = session.sub === ownerSub || memberSubs.includes(session.sub) || (guestEmails && guestEmails.includes(sessionEmail));
  if (!actorAllowed) { res.status(403).json({ error: 'not_authorized' }); return; }

  // Freno anti-spam.
  const key = `${session.sub}|${folderDriveId}|${kind}`;
  const { data: th } = await supabase.from('push_throttle').select('last_sent_at').eq('throttle_key', key).maybeSingle();
  if (th && Date.now() - new Date(th.last_sent_at).getTime() < THROTTLE_MS) {
    res.status(200).json({ ok: true, sent: 0, reason: 'throttled' });
    return;
  }
  await supabase.from('push_throttle').upsert({ throttle_key: key, last_sent_at: new Date().toISOString() });

  const recipientSubs = new Set([ownerSub, ...memberSubs]);
  if (guestEmails && guestEmails.length) {
    const { data: subs } = await supabase.from('subscriptions').select('google_sub,email').in('email', guestEmails);
    (subs || []).forEach(s => recipientSubs.add(s.google_sub));
    // Por si el mail quedó guardado con mayúsculas.
    const { data: subs2 } = await supabase.from('subscriptions').select('google_sub,email').or(guestEmails.map(e => `email.ilike.${e}`).join(','));
    (subs2 || []).forEach(s => recipientSubs.add(s.google_sub));
  }
  recipientSubs.delete(session.sub);
  if (!recipientSubs.size) { res.status(200).json({ ok: true, sent: 0, reason: 'no_recipients' }); return; }

  // Cada dispositivo elige qué tipos quiere recibir (v2.148).
  const prefCol = kind === 'note' ? 'notify_text' : 'notify_media';
  const { data: devices } = await supabase.from('push_subscriptions').select('endpoint,p256dh,auth').in('google_sub', [...recipientSubs]).eq(prefCol, true);
  if (!devices || !devices.length) { res.status(200).json({ ok: true, sent: 0, reason: 'no_devices' }); return; }

  webpush.setVapidDetails('https://legadofamiliar.com.ar', VAPID_PUBLIC_KEY.value(), VAPID_PRIVATE_KEY.value());
  const msg = buildMessage({ kind, count: Number(count) || 1, actorName: session.name, albumName: clean(albumName, MAX_NAME) });
  const payload = JSON.stringify({ ...msg, url: '/app.html', tag: `album-${folderDriveId}-${kind}` });

  let sent = 0;
  const dead = [];
  await Promise.all(devices.map(async d => {
    try {
      await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, payload, { TTL: 60 * 60 * 24 });
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(d.endpoint);
      else console.error('push send error:', e && e.statusCode, e && e.message);
    }
  }));
  if (dead.length) await supabase.from('push_subscriptions').delete().in('endpoint', dead);
  res.status(200).json({ ok: true, sent });
}

exports.pushApi = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY],
    enforceAppCheck: true,
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }
    const action = req.body && req.body.action;

    if (action === 'key') {
      res.status(200).json({ ok: true, publicKey: VAPID_PUBLIC_KEY.value() });
      return;
    }

    const session = verifySession(req, SESSION_JWT_SECRET.value());
    if (!session) { res.status(401).json({ error: 'invalid_session' }); return; }

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

      if (action === 'subscribe') {
        const sub = req.body.subscription || {};
        const endpoint = sub.endpoint;
        const p256dh = sub.keys && sub.keys.p256dh;
        const auth = sub.keys && sub.keys.auth;
        if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1000 || !p256dh || !auth) {
          res.status(400).json({ error: 'bad_subscription' });
          return;
        }
        const row = {
          endpoint, google_sub: session.sub, p256dh: String(p256dh), auth: String(auth),
          user_agent: clean(req.headers['user-agent'], 300),
        };
        const prefs = req.body.prefs;
        if (prefs && typeof prefs === 'object') {
          row.notify_media = prefs.media !== false;
          row.notify_text = prefs.text !== false;
        }
        const { error } = await supabase.from('push_subscriptions').upsert(row);
        if (error) { console.error('push subscribe error:', error); res.status(500).json({ error: 'subscribe_failed' }); return; }
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'unsubscribe') {
        const endpoint = req.body.endpoint;
        if (typeof endpoint !== 'string') { res.status(400).json({ error: 'bad_request' }); return; }
        await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('google_sub', session.sub);
        res.status(200).json({ ok: true });
        return;
      }

      if (action === 'status') {
        const endpoint = req.body.endpoint;
        if (typeof endpoint !== 'string') { res.status(200).json({ ok: true, subscribed: false }); return; }
        const { data } = await supabase.from('push_subscriptions').select('endpoint,notify_media,notify_text').eq('endpoint', endpoint).eq('google_sub', session.sub).maybeSingle();
        res.status(200).json({
          ok: true,
          subscribed: !!data,
          prefs: data ? { media: data.notify_media !== false, text: data.notify_text !== false } : null,
        });
        return;
      }

      if (action === 'prefs') {
        const endpoint = req.body.endpoint;
        const prefs = req.body.prefs || {};
        if (typeof endpoint !== 'string' || typeof prefs.media !== 'boolean' || typeof prefs.text !== 'boolean') {
          res.status(400).json({ error: 'bad_request' });
          return;
        }
        const { data, error } = await supabase.from('push_subscriptions')
          .update({ notify_media: prefs.media, notify_text: prefs.text })
          .eq('endpoint', endpoint).eq('google_sub', session.sub).select('endpoint');
        if (error) { console.error('push prefs error:', error); res.status(500).json({ error: 'prefs_failed' }); return; }
        res.status(200).json({ ok: true, updated: !!(data && data.length) });
        return;
      }

      if (action === 'notify') {
        await handleNotify(req, res, supabase, session);
        return;
      }

      res.status(400).json({ error: 'unknown_action' });
    } catch (e) {
      console.error('push error:', e && e.message);
      res.status(500).json({ error: 'push_failed' });
    }
  }
);
