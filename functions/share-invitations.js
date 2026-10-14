const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// v2.116 — ver CLAUDE.md → "Notificaciones de álbumes compartidos". Una sola
// función con tres acciones (para no sumar tres altas manuales de invoker
// público en Cloud Run):
//   create  — la dueña registra una invitación pendiente al compartir un álbum
//             por mail (el invitado se entera dentro de la app).
//   list    — el invitado consulta las pendientes de SU mail (el de la sesión,
//             validado por el servidor, nunca uno que mande el cliente).
//   resolve — el invitado la marca aceptada/descartada.
// El permiso real de Drive es la única autorización de acceso al contenido:
// esta tabla solo avisa, no concede nada. Mismo criterio de confianza que
// shared-album-register.js (el cliente no se verifica contra Drive), por eso
// todo texto se acota en largo y se escapa al renderizar en el frontend.
const ROLES = new Set(['reader', 'writer']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PENDING_PER_OWNER = 200;

function clip(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

exports.shareInvitations = onRequest(
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
    const session = verifySession(req, SESSION_JWT_SECRET.value());
    if (!session || !session.email) {
      res.status(401).json({ error: 'invalid_session' });
      return;
    }
    const body = req.body || {};
    const myEmail = String(session.email).toLowerCase();
    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

      if (body.action === 'create') {
        const guestEmail = clip(body.guestEmail, 254).toLowerCase();
        const folderDriveId = clip(body.folderDriveId, 200);
        const albumName = clip(body.albumName, 120);
        if (!guestEmail.includes('@') || !folderDriveId || !albumName) {
          res.status(400).json({ error: 'bad_request' });
          return;
        }
        if (guestEmail === myEmail) { res.status(200).json({ ok: true, skipped: 'self' }); return; }
        const role = ROLES.has(body.role) ? body.role : 'reader';
        const { count } = await supabase
          .from('share_invitations')
          .select('id', { count: 'exact', head: true })
          .eq('owner_google_sub', session.sub)
          .eq('status', 'pending');
        if ((count || 0) >= MAX_PENDING_PER_OWNER) {
          res.status(429).json({ error: 'too_many_pending' });
          return;
        }
        const { error } = await supabase.from('share_invitations').upsert({
          guest_email: guestEmail,
          folder_drive_id: folderDriveId,
          album_name: albumName,
          date_from: DATE_RE.test(body.dateFrom || '') ? body.dateFrom : null,
          date_to: DATE_RE.test(body.dateTo || '') ? body.dateTo : null,
          role,
          owner_google_sub: session.sub,
          owner_email: myEmail,
          owner_name: clip(session.name, 80) || null,
          status: 'pending',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'guest_email,folder_drive_id' });
        if (error) {
          console.error('share-invitations create error:', error);
          res.status(500).json({ error: 'create_failed' });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      if (body.action === 'list') {
        const { data, error } = await supabase
          .from('share_invitations')
          .select('folder_drive_id, album_name, date_from, date_to, role, owner_email, owner_name, created_at')
          .eq('guest_email', myEmail)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(50);
        if (error) {
          console.error('share-invitations list error:', error);
          res.status(500).json({ error: 'list_failed' });
          return;
        }
        res.status(200).json({
          invitations: (data || []).map(r => ({
            folderDriveId: r.folder_drive_id,
            albumName: r.album_name,
            dateFrom: r.date_from,
            dateTo: r.date_to,
            role: r.role,
            ownerEmail: r.owner_email,
            ownerName: r.owner_name,
            createdAt: r.created_at,
          })),
        });
        return;
      }

      if (body.action === 'resolve') {
        const folderDriveId = clip(body.folderDriveId, 200);
        const status = body.status === 'accepted' ? 'accepted' : body.status === 'dismissed' ? 'dismissed' : null;
        if (!folderDriveId || !status) {
          res.status(400).json({ error: 'bad_request' });
          return;
        }
        const { error } = await supabase
          .from('share_invitations')
          .update({ status, updated_at: new Date().toISOString() })
          .eq('guest_email', myEmail)
          .eq('folder_drive_id', folderDriveId);
        if (error) {
          console.error('share-invitations resolve error:', error);
          res.status(500).json({ error: 'resolve_failed' });
          return;
        }
        res.status(200).json({ ok: true });
        return;
      }

      res.status(400).json({ error: 'unknown_action' });
    } catch (e) {
      console.error('share-invitations error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
