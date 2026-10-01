const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// Rol "Contribuidor" — álbumes compartidos sin pedir mail, por link/QR (ver
// CLAUDE.md → "Álbumes compartidos: rol Contribuidor (QR, sin mail)"). La
// dueña genera acá un token que NO está atado a ninguna cuenta puntual —
// a diferencia de shareAlbumWithUser()/shareFolder (que llaman a
// permissions.create de Drive con un mail concreto), este endpoint nunca
// toca Drive: el token vive 100% en Supabase, y la autorización real para
// un Contribuidor se resuelve después consultando shared_album_members en
// vez de los permisos reales de la carpeta (ver shared-album-proxy.js,
// próximo paso). Por eso no hace falta ni el refresh_token de la dueña ni
// ningún secret de Google acá — es la pieza más simple de todo este
// mecanismo.
//
// Mismo criterio de confianza que shared-album-register.js: la única
// prueba de que quien llama es dueño del álbum es que su JWT de sesión sea
// válido — no se verifica contra Drive quién es el dueño real de
// folderDriveId, porque la única forma de alcanzar este endpoint desde la
// app es tocando el botón "Compartir" DENTRO de un álbum que ya es propio
// (la UI nunca ofrece esto en un álbum ajeno). Upsertear shared_album_owner
// acá (igual que shared-album-register.js) es lo que deja a
// shared-album-proxy.js listo para leer/escribir en nombre de un
// Contribuidor sin que la dueña haya tenido que compartir antes por mail.
exports.sharedAlbumInviteCreate = onRequest(
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

    const { folderDriveId, role, expiresAt } = req.body || {};
    if (!folderDriveId || typeof folderDriveId !== 'string') {
      res.status(400).json({ error: 'bad_request', detail: 'missing_folder_drive_id' });
      return;
    }
    if (role !== 'contributor') {
      res.status(400).json({ error: 'bad_request', detail: 'unsupported_role' });
      return;
    }
    let expiresAtIso = null;
    if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        res.status(400).json({ error: 'bad_request', detail: 'invalid_expires_at' });
        return;
      }
      expiresAtIso = d.toISOString();
    }

    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

      const { error: ownerErr } = await supabase
        .from('shared_album_owner')
        .upsert({ folder_drive_id: folderDriveId, owner_google_sub: session.sub }, { onConflict: 'folder_drive_id' });
      if (ownerErr) {
        console.error('shared-album-invite-create owner upsert error:', ownerErr);
        res.status(500).json({ error: 'owner_register_failed' });
        return;
      }

      const token = crypto.randomUUID();
      const { error: insertErr } = await supabase
        .from('shared_album_invites')
        .insert({
          token,
          folder_drive_id: folderDriveId,
          role,
          owner_google_sub: session.sub,
          expires_at: expiresAtIso,
        });
      if (insertErr) {
        console.error('shared-album-invite-create insert error:', insertErr);
        res.status(500).json({ error: 'invite_create_failed' });
        return;
      }

      res.status(200).json({ ok: true, token, role, expiresAt: expiresAtIso });
    } catch (e) {
      console.error('shared-album-invite-create error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
