const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// Contraparte de shared-album-invite-create.js — cualquier cuenta de
// Google autenticada (td_session) que mande un token válido queda
// registrada en shared_album_members con el rol que el token diga, sin
// que la dueña haya tenido que poner su mail en ningún lado de antemano.
// Nunca toca Drive — toda la autorización vive en Supabase, y
// shared-album-proxy.js es quien después la va a consultar (próximo paso)
// en vez de preguntarle a Drive por un permiso que para un Contribuidor
// nunca existió.
//
// Códigos de error devueltos, pensados para que el frontend pueda mostrar
// un motivo específico en vez de un error genérico:
//   invalid_session   — el JWT de sesión no es válido/venció
//   bad_request       — falta el token en el body
//   invite_not_found  — el token no existe (link mal copiado, o ya borrado)
//   invite_inactive   — la dueña desactivó este link a mano
//   invite_expired    — venció la fecha límite del link
//   is_owner          — la propia dueña escaneó/abrió su propio link
exports.sharedAlbumInviteJoin = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
    enforceAppCheck: true,
    maxInstances: 10,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    const { token, via, preview } = req.body || {};

    // v2.140: modo "preview", SIN sesión — la pantalla previa al login
    // ("Te invitaron a sumarte al álbum X") necesita el nombre antes de que
    // la persona se identifique. Solo devuelve nombre y estado del link,
    // nunca une a nadie ni toca shared_album_members. Quien tiene el token
    // ya tiene el link, así que el nombre no filtra nada nuevo. App Check
    // sigue exigido (enforceAppCheck), así que no es un endpoint abierto.
    if (preview === true) {
      if (!token || typeof token !== 'string') { res.status(400).json({ error: 'bad_request' }); return; }
      try {
        const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
        const { data: inv, error: invErr } = await supabase
          .from('shared_album_invites')
          .select('album_name, active, expires_at')
          .eq('token', token)
          .maybeSingle();
        if (invErr) { console.error('shared-album-invite-join preview error:', invErr); res.status(500).json({ error: 'invite_lookup_failed' }); return; }
        if (!inv) { res.status(404).json({ error: 'invite_not_found' }); return; }
        const expired = inv.expires_at && new Date(inv.expires_at).getTime() <= Date.now();
        const status = !inv.active ? 'inactive' : (expired ? 'expired' : 'ok');
        res.status(200).json({ ok: true, albumName: inv.album_name || null, status });
      } catch (e) {
        console.error('shared-album-invite-join preview error:', e);
        res.status(500).json({ error: 'internal_error' });
      }
      return;
    }

    const session = verifySession(req, SESSION_JWT_SECRET.value());
    if (!session) {
      res.status(401).json({ error: 'invalid_session' });
      return;
    }

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'bad_request' });
      return;
    }
    const joinedVia = via === 'qr' ? 'qr' : 'link';

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

      const { data: invite, error: inviteErr } = await supabase
        .from('shared_album_invites')
        .select('folder_drive_id, role, owner_google_sub, active, expires_at')
        .eq('token', token)
        .maybeSingle();
      if (inviteErr) { console.error('shared-album-invite-join lookup error:', inviteErr); res.status(500).json({ error: 'invite_lookup_failed' }); return; }
      if (!invite) { res.status(404).json({ error: 'invite_not_found' }); return; }
      if (!invite.active) { res.status(403).json({ error: 'invite_inactive' }); return; }
      if (invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now()) { res.status(403).json({ error: 'invite_expired' }); return; }
      if (invite.owner_google_sub === session.sub) { res.status(409).json({ error: 'is_owner' }); return; }

      const { data: existing, error: existingErr } = await supabase
        .from('shared_album_members')
        .select('guest_google_sub')
        .eq('folder_drive_id', invite.folder_drive_id)
        .eq('guest_google_sub', session.sub)
        .maybeSingle();
      if (existingErr) { console.error('shared-album-invite-join existing lookup error:', existingErr); res.status(500).json({ error: 'invite_lookup_failed' }); return; }
      const isNewMember = !existing;

      const { error: memberErr } = await supabase
        .from('shared_album_members')
        .upsert({
          folder_drive_id: invite.folder_drive_id,
          guest_google_sub: session.sub,
          role: invite.role,
          joined_via: joinedVia,
        }, { onConflict: 'folder_drive_id,guest_google_sub' });
      if (memberErr) { console.error('shared-album-invite-join member upsert error:', memberErr); res.status(500).json({ error: 'join_failed' }); return; }

      if (isNewMember) {
        // Best-effort — un fallo acá nunca debe tumbar el join real, mismo
        // criterio que signup_completed en auth-session.js.
        try {
          await supabase.from('usage_events').insert({
            google_sub: session.sub,
            event_name: 'shared_album_joined',
            event_props: { role: invite.role, via: joinedVia },
          });
        } catch (e) {
          console.error('shared-album-invite-join tracking error:', e);
        }
      }

      res.status(200).json({ ok: true, folderDriveId: invite.folder_drive_id, role: invite.role });
    } catch (e) {
      console.error('shared-album-invite-join error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
