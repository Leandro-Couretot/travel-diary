const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');
const { mintAccessTokenFromRefreshToken } = require('./lib/driveAuth');

const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// v2.61 — Proxy de lectura para álbumes compartidos.
//
// Por qué existe: el scope `drive.file` de esta app nunca le da a un
// invitado visibilidad real sobre el CONTENIDO de una carpeta que no creó
// él mismo — ni siquiera después de confirmarla con el Google Picker
// (ver CLAUDE.md → "El scope drive.file no da acceso al contenido de una
// carpeta compartida, ni siquiera con el Picker", límite documentado por
// Google y por la comunidad, no un bug de esta app). La única cuenta que
// SÍ tiene acceso real a ese contenido es la DUEÑA del álbum (ella lo creó,
// drive.file le da visibilidad total sobre lo propio). Este endpoint deja
// que el servidor lea el contenido usando el access_token de la DUEÑA
// (minteado a partir de su refresh_token guardado, ver "Auth de Drive: de
// implícito a refresh_token real"), autenticando al INVITADO por su propia
// sesión (td_session) — nunca por su token de Drive, que es justo el que
// no alcanza acá — y devolviéndole el resultado.
//
// Autorización, en cada pedido (nunca cacheada, se re-chequea siempre
// contra el estado real de Drive — mismo patrón que checkFolderShareApplied,
// v2.53, así que si el dueño revoca el acceso desde su propio Drive, el
// próximo pedido del invitado se corta solo, sin que nadie tenga que
// actualizar ninguna tabla):
//   1. El JWT de sesión del invitado (td_session) prueba quién es de verdad
//      (mismo mecanismo que el resto de las Cloud Functions).
//   2. shared_album_owner (Supabase) dice de quién es folderDriveId.
//   3. Se mintea un access_token de la DUEÑA con su refresh_token guardado.
//   4. Se listan los permisos REALES de folderDriveId con ese token — si el
//      email del invitado no figura ahí (cualquier rol), 403.
//   5. Recién ahí se despacha la acción pedida.
//
// Cada acción es un primitivo genérico y acotado (nunca una URL arbitraria
// que el cliente arme) — y cualquier id de archivo/carpeta que no sea
// folderDriveId en sí se valida como descendiente real de folderDriveId
// antes de tocarlo (isDescendant), para que un cliente comprometido no
// pueda usar este proxy para leer archivos del resto del Drive de la
// dueña.
exports.sharedAlbumProxy = onRequest(
  {
    region: 'southamerica-east1',
    secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SESSION_JWT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY],
    enforceAppCheck: true,
    maxInstances: 10,
    memory: '512MiB', // getMediaBytes puede mover fotos/videos varios MB
    timeoutSeconds: 120,
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
    const { folderDriveId, action, params } = req.body || {};
    if (!folderDriveId || typeof folderDriveId !== 'string' || !action) {
      res.status(400).json({ error: 'bad_request' });
      return;
    }

    let supabase, ownerAccessToken;
    try {
      supabase = getSupabaseClient(SUPABASE_URL.value(), SUPABASE_SERVICE_ROLE_KEY.value());

      const { data: ownerRow, error: ownerErr } = await supabase
        .from('shared_album_owner')
        .select('owner_google_sub')
        .eq('folder_drive_id', folderDriveId)
        .maybeSingle();
      if (ownerErr) { console.error('shared-album-proxy owner lookup error:', ownerErr); res.status(500).json({ error: 'owner_lookup_failed' }); return; }
      if (!ownerRow) { res.status(404).json({ error: 'not_shared' }); return; }

      const { data: subRow, error: subErr } = await supabase
        .from('subscriptions')
        .select('drive_refresh_token')
        .eq('google_sub', ownerRow.owner_google_sub)
        .maybeSingle();
      if (subErr) { console.error('shared-album-proxy refresh_token lookup error:', subErr); res.status(500).json({ error: 'owner_lookup_failed' }); return; }
      if (!subRow || !subRow.drive_refresh_token) {
        // La dueña nunca migró al flujo de refresh_token real (v1.91) o lo
        // perdió (revocó el acceso, etc.) — sin esto no hay forma de leer
        // en su nombre. Código de error específico para que el frontend
        // pueda distinguir esto de "no tenés permiso" y mostrar un mensaje
        // que apunte al motivo real.
        res.status(409).json({ error: 'owner_not_migrated' });
        return;
      }

      try {
        ({ accessToken: ownerAccessToken } = await mintAccessTokenFromRefreshToken(subRow.drive_refresh_token, GOOGLE_CLIENT_ID.value(), GOOGLE_CLIENT_SECRET.value()));
      } catch (e) {
        await supabase.from('subscriptions').update({ drive_refresh_token: null }).eq('google_sub', ownerRow.owner_google_sub);
        res.status(409).json({ error: 'owner_token_invalid' });
        return;
      }

      const authorized = await guestHasAccess(folderDriveId, session.email, ownerAccessToken);
      if (!authorized) { res.status(403).json({ error: 'not_authorized' }); return; }

      await dispatchAction(action, params || {}, folderDriveId, ownerAccessToken, res);
    } catch (e) {
      console.error('shared-album-proxy error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  }
);

async function driveFetch(url, accessToken) {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

async function guestHasAccess(folderDriveId, guestEmail, ownerAccessToken) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderDriveId}?fields=trashed,permissions(emailAddress,role)`, ownerAccessToken);
  if (!res.ok) return false;
  const data = await res.json();
  if (data.trashed) return false;
  const perms = data.permissions || [];
  const target = guestEmail.toLowerCase();
  return perms.some(p => (p.emailAddress || '').toLowerCase() === target);
}

// Confirma que `id` es folderDriveId en sí, o un descendiente real —
// camina `parents` hacia arriba hasta encontrar folderDriveId o agotar
// maxDepth. En esta app la profundidad real nunca supera 2 (álbum → día →
// archivo), el margen extra es solo defensivo.
async function isDescendant(id, folderDriveId, ownerAccessToken, maxDepth = 5) {
  if (id === folderDriveId) return true;
  let current = id;
  for (let depth = 0; depth < maxDepth; depth++) {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${current}?fields=id,parents`, ownerAccessToken);
    if (!res.ok) return false;
    const data = await res.json();
    const parents = data.parents || [];
    if (parents.includes(folderDriveId)) return true;
    if (!parents.length) return false;
    current = parents[0];
  }
  return false;
}

async function dispatchAction(action, params, folderDriveId, ownerAccessToken, res) {
  if (action === 'listFolders') {
    const parentId = params.parentId;
    if (!parentId || !(await isDescendant(parentId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const q = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
    const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name&pageSize=1000`, ownerAccessToken);
    if (!dr.ok) { res.status(502).json({ error: 'drive_error' }); return; }
    const data = await dr.json();
    res.status(200).json({ folders: data.files || [] });
    return;
  }

  if (action === 'listFiles') {
    const parentId = params.parentId;
    if (!parentId || !(await isDescendant(parentId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const q = `'${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
    const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=1000`, ownerAccessToken);
    if (!dr.ok) { res.status(502).json({ error: 'drive_error' }); return; }
    const data = await dr.json();
    res.status(200).json({ files: data.files || [] });
    return;
  }

  if (action === 'findFileByName') {
    const parentId = params.parentId;
    const names = Array.isArray(params.names) ? params.names : [params.names];
    if (!parentId || !names.length || !(await isDescendant(parentId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    for (const name of names) {
      if (!name) continue;
      const q = `name='${String(name).replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
      const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, ownerAccessToken);
      if (!dr.ok) continue;
      const data = await dr.json();
      if (data.files && data.files.length) { res.status(200).json({ id: data.files[0].id }); return; }
    }
    res.status(200).json({ id: null });
    return;
  }

  if (action === 'getFileJson') {
    const fileId = params.fileId;
    if (!fileId || !(await isDescendant(fileId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, ownerAccessToken);
    if (!dr.ok) { res.status(404).json({ error: 'not_found' }); return; }
    try {
      const json = await dr.json();
      res.status(200).json({ content: json });
    } catch {
      res.status(502).json({ error: 'invalid_json' });
    }
    return;
  }

  if (action === 'getMediaBytes') {
    const fileId = params.fileId;
    if (!fileId || !(await isDescendant(fileId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, ownerAccessToken);
    if (!dr.ok) { res.status(404).json({ error: 'not_found' }); return; }
    const contentType = dr.headers.get('content-type') || 'application/octet-stream';
    const buf = Buffer.from(await dr.arrayBuffer());
    res.status(200).set('Content-Type', contentType).send(buf);
    return;
  }

  res.status(400).json({ error: 'unknown_action' });
}
