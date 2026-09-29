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
//
// v2.62 — Acciones de ESCRITURA (getOrCreateFolder/uploadMedia/writeJson/
// trashFile): mismo mecanismo, pero para que un invitado con rol de
// EDITOR pueda subir/borrar fotos, escribir notas, grabar audio, etc. en
// un álbum compartido — hasta acá el escritor seguía usando su propio
// token (drive.file), que nunca puede tocar un día/archivo que no creó
// él mismo (mismo límite de fondo que bloqueaba la lectura, dado vuelta:
// una foto que el invitado sube bajo SU autorización nunca es visible
// para el token de la dueña, así que el proxy de lectura nunca la
// encontraba). La solución es la misma: el servidor escribe usando el
// access_token de la DUEÑA, autenticando al invitado por su sesión. Un
// rol de solo lectura (`reader`) nunca puede disparar ninguna de estas
// 4 acciones — se re-chequea el rol real en cada pedido, igual que la
// lectura.
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

      const role = await guestRole(folderDriveId, session.email, ownerAccessToken);
      if (!role) { res.status(403).json({ error: 'not_authorized' }); return; }
      if (WRITE_ACTIONS.has(action) && !EDITOR_ROLES.has(role)) { res.status(403).json({ error: 'read_only' }); return; }

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

// v2.62: devuelve el rol real (`'reader'`/`'writer'`/...) en vez de solo
// true/false — lectura sigue aceptando cualquier rol, escritura exige uno
// de EDITOR_ROLES (chequeado en el handler principal).
const EDITOR_ROLES = new Set(['owner', 'organizer', 'fileOrganizer', 'writer']);
const WRITE_ACTIONS = new Set(['getOrCreateFolder', 'uploadMedia', 'writeJson', 'trashFile']);

async function guestRole(folderDriveId, guestEmail, ownerAccessToken) {
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderDriveId}?fields=trashed,permissions(emailAddress,role)`, ownerAccessToken);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.trashed) return null;
  const perms = data.permissions || [];
  const target = guestEmail.toLowerCase();
  const match = perms.find(p => (p.emailAddress || '').toLowerCase() === target);
  return match ? match.role : null;
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

  // ── Escritura (v2.62, ver el comentario grande al principio del archivo) ──

  if (action === 'getOrCreateFolder') {
    const { parentId, name } = params;
    if (!parentId || !name || !(await isDescendant(parentId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const existing = await driveFindByName(parentId, name, ownerAccessToken);
    if (existing) { res.status(200).json({ id: existing }); return; }
    const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
    });
    if (!cr.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(cr) }); return; }
    const folder = await cr.json();
    res.status(200).json({ id: folder.id });
    return;
  }

  if (action === 'uploadMedia') {
    const { parentId, name, mimeType, dataBase64, existingId, description } = params;
    if (!name || !dataBase64) { res.status(400).json({ error: 'bad_request' }); return; }
    const targetOk = existingId
      ? await isDescendant(existingId, folderDriveId, ownerAccessToken)
      : (parentId && await isDescendant(parentId, folderDriveId, ownerAccessToken));
    if (!targetOk) { res.status(403).json({ error: 'not_authorized' }); return; }
    const buf = Buffer.from(dataBase64, 'base64');
    const ur = await driveUploadMultipart(existingId, name, parentId, description, buf, mimeType, ownerAccessToken);
    if (!ur.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(ur) }); return; }
    const file = await ur.json();
    res.status(200).json({ id: file.id });
    return;
  }

  if (action === 'writeJson') {
    const { parentId, newName, oldNames, content, description } = params;
    if (!parentId || !newName || content === undefined || !(await isDescendant(parentId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    let existingId = await driveFindByName(parentId, newName, ownerAccessToken);
    if (!existingId) {
      for (const oldName of (Array.isArray(oldNames) ? oldNames : (oldNames ? [oldNames] : []))) {
        existingId = await driveFindByName(parentId, oldName, ownerAccessToken);
        if (existingId) break;
      }
    }
    const buf = Buffer.from(JSON.stringify(content, null, 2), 'utf8');
    const ur = await driveUploadMultipart(existingId, newName, parentId, description, buf, 'application/json', ownerAccessToken);
    if (!ur.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(ur) }); return; }
    const file = await ur.json();
    res.status(200).json({ id: file.id });
    return;
  }

  if (action === 'trashFile') {
    const fileId = params.fileId;
    if (!fileId || !(await isDescendant(fileId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    if (!pr.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(pr) }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'unknown_action' });
}

// Mismo find-by-name (un solo nombre) que ya usaba la acción
// `findFileByName` de lectura para cada nombre de su lista — extraído acá
// para reusarlo también en `getOrCreateFolder`/`writeJson`, que necesitan
// resolver un id existente antes de decidir crear vs. actualizar.
async function driveFindByName(parentId, name, ownerAccessToken) {
  const q = `name='${String(name).replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
  const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`, ownerAccessToken);
  if (!dr.ok) return null;
  const data = await dr.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

// Multipart upload/update genérico (nuevo archivo si `existingId` es
// falsy, PATCH de contenido si no) — mismo formato que uploadFile() del
// lado del cliente (drive.js), reusado tanto para media real
// (uploadMedia) como para JSON (writeJson).
async function driveUploadMultipart(existingId, name, parentId, description, buf, mimeType, ownerAccessToken) {
  const meta = { name };
  if (description) meta.description = description;
  if (!existingId) meta.parents = [parentId];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', new Blob([buf], { type: mimeType || 'application/octet-stream' }));
  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  return fetch(url, { method: existingId ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${ownerAccessToken}` }, body: form });
}

// Reenvía el error real de Drive (útil para que el cliente pueda detectar
// cuota excedida igual que con un pedido directo — ver _isQuotaExceeded()
// en drive.js) — nunca tira si el cuerpo no es JSON parseable.
async function driveErrorDetail(res) {
  try { return (await res.clone().json()).error || null; } catch { return null; }
}
