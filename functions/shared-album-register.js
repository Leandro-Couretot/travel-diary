const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');

const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// v2.61 — ver CLAUDE.md → "El scope drive.file no da acceso al contenido de
// una carpeta compartida, ni siquiera con el Picker". Se llama desde
// submitShare() (app.html) apenas se confirma que un álbum quedó
// efectivamente compartido — registra qué cuenta es la DUEÑA real de esa
// carpeta, para que shared-album-proxy.js sepa de quién usar el
// refresh_token al leer contenido en nombre de un invitado. No guarda nada
// por invitado — la autorización real se chequea en vivo contra los
// permisos de Drive en cada pedido del proxy (mismo patrón que
// checkFolderShareApplied, v2.53), así que esta tabla nunca queda
// desactualizada si el dueño cambia a quién le comparte después.
exports.sharedAlbumRegister = onRequest(
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
    const folderDriveId = req.body && req.body.folderDriveId;
    if (!folderDriveId || typeof folderDriveId !== 'string') {
      res.status(400).json({ error: 'missing_folder_drive_id' });
      return;
    }
    try {
      const supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());
      const { error } = await supabase
        .from('shared_album_owner')
        .upsert({ folder_drive_id: folderDriveId, owner_google_sub: session.sub }, { onConflict: 'folder_drive_id' });
      if (error) {
        console.error('shared-album-register upsert error:', error);
        res.status(500).json({ error: 'upsert_failed' });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (e) {
      console.error('shared-album-register error:', e);
      res.status(500).json({ error: 'internal_error' });
    }
  }
);
