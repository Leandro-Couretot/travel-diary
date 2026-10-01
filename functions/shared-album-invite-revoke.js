const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// "Dejar de compartir por contribuidores" — el toggle manual que se suma
// al vencimiento automático (expires_at, ver shared-album-invite-create.js)
// para cortar NUEVAS uniones. Nunca le saca el acceso a quien ya se unió
// — eso vive en shared_album_members, esta función no lo toca.
//
// Con `token`: desactiva ese link puntual. Sin `token` (solo
// `folderDriveId`): desactiva TODOS los links de Contribuidor activos de
// ese álbum de una — es el caso de uso real del toggle ("apagar el QR del
// álbum"), sin que la dueña tenga que acordarse de cuántos links generó.
// En los dos casos, solo afecta invitaciones de las que `session.sub` es
// la dueña real — no hay forma de apagar el link de otra cuenta.
exports.sharedAlbumInviteRevoke = onRequest(
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
    if (!session) {
      res.status(401).json({ error: 'invalid_session' });
      return;
    }

    const { token, folderDriveId } = req.body || {};
    if (!token && !folderDriveId) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      let query = supabase
        .from('shared_album_invites')
        .update({ active: false })
        .eq('owner_google_sub', session.sub);
      query = token ? query.eq('token', token) : query.eq('folder_drive_id', folderDriveId);
      const { error } = await query;
      if (error) {
        console.error('shared-album-invite-revoke update error:', error);
        res.status(500).json({ error: 'revoke_failed' });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('shared-album-invite-revoke error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
