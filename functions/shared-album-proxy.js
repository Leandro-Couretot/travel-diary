const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getSupabaseClient } = require('./lib/supabase');
const { verifySession } = require('./lib/session');
const { mintAccessTokenFromRefreshToken } = require('./lib/driveAuth');

// Mismos nombres que ALBUMS_JSON_NAME/ALBUMS_JSON_OLD_NAME en drive.js —
// duplicados a propósito (no hay ningún módulo compartido entre el
// frontend y functions/ hoy) para que getAlbumMeta pueda encontrar el
// albums.json real de la dueña sin depender de que el cliente le diga
// dónde está.
const ALBUMS_JSON_NAME = '[Legado] - Mis álbumes.json';
const ALBUMS_JSON_OLD_NAMES = ['[Travel Diary] - Mis álbumes.json', 'albums.json'];

const GOOGLE_CLIENT_ID = defineSecret('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = defineSecret('GOOGLE_CLIENT_SECRET');
const SESSION_JWT_SECRET = defineSecret('SESSION_JWT_SECRET');
const SUPABASE_URL = defineSecret('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = defineSecret('SUPABASE_SERVICE_ROLE_KEY');

// v2.65 — ver el comentario grande sobre "Cachés en memoria" más abajo.
const ownerTokenCache = new Map(); // owner_google_sub -> { accessToken, expiresAt }
const guestPermissionCache = new Map(); // "email:folderDriveId" -> { role, expiresAt }
const OWNER_TOKEN_SAFETY_BUFFER_MS = 5 * 60 * 1000;
const GUEST_PERMISSION_TTL_MS = 15 * 60 * 1000;

// v2.70 (Paso 2) — Rol "Contribuidor", ver CLAUDE.md → "Rol 'Contribuidor'".
// A diferencia de Lector/Co-propietario (resueltos en vivo contra los
// permisos reales de la carpeta, `guestRole()` más abajo), un Contribuidor
// nunca tiene un permiso real de Drive — se une por link/QR, sin que la
// dueña le haya compartido nada por mail. Su autorización vive 100% en
// `shared_album_members` (Supabase), chequeada ANTES de intentar nada
// contra Drive. Set acotado de acciones de escritura — nunca las genéricas
// `writeJson`/`trashFile` (dejarían que un Contribuidor reescriba el
// day.json entero, pisando título/notas/fotos ajenas) — en su lugar,
// `contributorAppendMedia`/`contributorTrashOwnMedia`, que hacen el merge
// del lado del servidor y nunca aceptan el contenido completo de un
// archivo de parte del cliente.
const CONTRIBUTOR_WRITE_ACTIONS = new Set(['getOrCreateFolder', 'uploadMedia', 'contributorAppendMedia', 'contributorTrashOwnMedia']);

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
// Autorización, en cada pedido:
//   1. El JWT de sesión del invitado (td_session) prueba quién es de verdad
//      (mismo mecanismo que el resto de las Cloud Functions).
//   2. shared_album_owner (Supabase) dice de quién es folderDriveId — este
//      lookup puntual nunca se cachea, es barato y casi nunca cambia.
//   3. Se mintea un access_token de la DUEÑA con su refresh_token guardado
//      — desde v2.65, CACHEADO por owner_google_sub (ver más abajo).
//   4. Se listan los permisos REALES de folderDriveId con ese token — si el
//      email del invitado no figura ahí (cualquier rol), 403 — desde
//      v2.65, el resultado positivo se CACHEA por invitado+álbum (ver
//      más abajo). Antes de v2.65 este chequeo se repetía sin caché en
//      cada pedido (mismo patrón que checkFolderShareApplied, v2.53), así
//      que un revoke del dueño se cortaba al instante en el próximo
//      pedido — con la caché, revocar tarda hasta el TTL en surtir efecto
//      (ver "Cachés" más abajo para el porqué de esta decisión).
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
//
// v2.64 — Acción de lectura nueva (getAlbumMeta): devuelve nombre/fechas/
// portada REALES del álbum, leídos del albums.json de la dueña — no del
// shared-albums.json cacheado del invitado, que solo se poblaba una vez
// al unirse y nunca se refrescaba (bug real: fechas desactualizadas/
// incompletas). Es la única acción que no pasa por isDescendant(), porque
// albums.json vive en la raíz del Drive de la dueña, no dentro de la
// carpeta del álbum — la autorización sigue siendo folderDriveId en sí,
// ya validado por guestRole(), y solo se devuelve la entrada de ESE álbum.
//
// v2.65 — Cachés en memoria para el "preámbulo" de autorización, a pedido
// del usuario tras probar v2.61-v2.64 con la cuenta de su esposa: abrir un
// álbum compartido se sentía notoriamente más lento que uno propio. Causa
// real: cada UNA de las decenas de llamadas al proxy que dispara una sola
// sesión de navegación (listar días, leer cada day.json, bajar cada foto)
// repetía el preámbulo completo — 2 lookups a Supabase + 1 canje real con
// Google + 1 chequeo de permisos contra Drive — sin ningún caché, aunque
// esas llamadas ocurran todas en la misma sesión, segundos entre sí.
// Decisión explícita del usuario, para este caso: "para una app familiar
// no es necesario tanta rapidez en quitar permisos" — se acepta que
// revocar un acceso tarde hasta un rato en surtir efecto, a cambio de
// evitar pagar este costo en cada pedido individual. Dos cachés, con
// alcances distintos:
//   - `ownerTokenCache`: el access_token minteado de una DUEÑA, guardado
//     por `owner_google_sub` (no por álbum — sirve para CUALQUIER álbum
//     de esa misma dueña) durante el tiempo que Google dice que es válido
//     de verdad (`expiresIn`, ~1h) menos un margen de seguridad.
//   - `guestPermissionCache`: el ROL real de un invitado sobre UN álbum
//     puntual, guardado por invitado+folderDriveId durante
//     `GUEST_PERMISSION_TTL_MS` (15 min) — el permiso es específico de esa
//     carpeta, así que esta caché no se comparte entre álbumes distintos
//     aunque sean de la misma dueña. Solo se cachea un resultado
//     POSITIVO (rol real encontrado) — un `null` (denegado, o un error de
//     Drive tratado como denegado por el mismo criterio fail-closed de
//     siempre) nunca se cachea, para no extender una falla transitoria de
//     Drive en una ventana de 15 minutos de rechazo.
// Ambas viven en memoria del proceso — best-effort, no una garantía dura:
// una instancia nueva de la Cloud Function (cold start, escalado) arranca
// sin nada cacheado y paga el precio completo una vez más, sin que esto
// sea un bug ni necesite ninguna infraestructura de caché compartida
// (Redis, etc.) para el volumen de tráfico real de esta app.
//
// v2.67 — `shareFolder` (invitar a una persona más) para que un invitado
// EDITOR tenga la misma experiencia que en un álbum propio, salvo lo que
// sigue siendo exclusivo de la dueña real (archivar/eliminar el álbum,
// y desde v2.82 también editar su nombre/fechas — ver "Ver en Drive +
// 'Editar álbum' deja de ofrecerse a invitados" en CLAUDE.md). Necesita
// el token de la DUEÑA por el mismo límite de fondo de drive.file que ya
// motivó todo este proxy (el token del invitado nunca puede tocar algo
// que no creó él mismo, ni siquiera con rol de editor).
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

      try {
        ownerAccessToken = await getOwnerAccessToken(supabase, ownerRow.owner_google_sub, GOOGLE_CLIENT_ID.value(), GOOGLE_CLIENT_SECRET.value());
      } catch (e) {
        if (e.code === 'owner_not_migrated') {
          // La dueña nunca migró al flujo de refresh_token real (v1.91) o
          // lo perdió (revocó el acceso, etc.) — sin esto no hay forma de
          // leer en su nombre. Código de error específico para que el
          // frontend pueda distinguir esto de "no tenés permiso" y mostrar
          // un mensaje que apunte al motivo real.
          res.status(409).json({ error: 'owner_not_migrated' });
        } else if (e.code === 'owner_token_invalid') {
          res.status(409).json({ error: 'owner_token_invalid' });
        } else {
          console.error('shared-album-proxy owner token error:', e);
          res.status(500).json({ error: 'owner_lookup_failed' });
        }
        return;
      }

      // v2.70 (Paso 2): un Contribuidor nunca tiene permiso real de Drive —
      // se chequea primero contra la tabla de acceso propia (barato, sin
      // tocar Drive) y solo si no hay nada ahí se cae al chequeo de
      // siempre contra los permisos reales de la carpeta (Lector/
      // Co-propietario).
      let role = await getContributorRole(supabase, folderDriveId, session.sub);
      if (!role) role = await getGuestRoleCached(folderDriveId, session.email, ownerAccessToken);
      if (!role) { res.status(403).json({ error: 'not_authorized' }); return; }

      // whoAmI (v2.74, rol Contribuidor Paso 5): el cliente necesita saber
      // SU PROPIO rol real ANTES de decidir qué vista mostrar al entrar a
      // un álbum compartido — hasta acá el rol solo se resolvía puertas
      // adentro del servidor, en cada pedido, sin devolvérselo a nadie.
      // Lectura pura, sin tocar Drive ni Supabase de más (el rol ya se
      // resolvió arriba) — no pasa por dispatchAction() porque no encaja
      // en el molde de una acción sobre un archivo/carpeta puntual.
      if (action === 'whoAmI') { res.status(200).json({ ok: true, role }); return; }

      if (WRITE_ACTIONS.has(action)) {
        if (role === 'contributor') {
          if (!CONTRIBUTOR_WRITE_ACTIONS.has(action)) { res.status(403).json({ error: 'read_only' }); return; }
        } else if (!EDITOR_ROLES.has(role)) {
          res.status(403).json({ error: 'read_only' }); return;
        }
      }

      await dispatchAction(action, params || {}, folderDriveId, ownerAccessToken, res, session.sub);
    } catch (e) {
      console.error('shared-album-proxy error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
    }
  }
);

// v2.65: mintea el access_token de la dueña solo si no hay uno cacheado
// todavía vigente para su cuenta — ver "Cachés en memoria" arriba. Tira un
// error con `.code` para que el caller decida el status HTTP correcto sin
// duplicar esa lógica acá.
async function getOwnerAccessToken(supabase, ownerGoogleSub, clientId, clientSecret) {
  const cached = ownerTokenCache.get(ownerGoogleSub);
  if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

  const { data: subRow, error: subErr } = await supabase
    .from('subscriptions')
    .select('drive_refresh_token')
    .eq('google_sub', ownerGoogleSub)
    .maybeSingle();
  if (subErr) { console.error('shared-album-proxy refresh_token lookup error:', subErr); const e = new Error('owner_lookup_failed'); e.code = 'owner_lookup_failed'; throw e; }
  if (!subRow || !subRow.drive_refresh_token) { const e = new Error('owner_not_migrated'); e.code = 'owner_not_migrated'; throw e; }

  let accessToken, expiresIn;
  try {
    ({ accessToken, expiresIn } = await mintAccessTokenFromRefreshToken(subRow.drive_refresh_token, clientId, clientSecret));
  } catch (e) {
    await supabase.from('subscriptions').update({ drive_refresh_token: null }).eq('google_sub', ownerGoogleSub);
    const err = new Error('owner_token_invalid'); err.code = 'owner_token_invalid'; throw err;
  }
  ownerTokenCache.set(ownerGoogleSub, { accessToken, expiresAt: Date.now() + expiresIn * 1000 - OWNER_TOKEN_SAFETY_BUFFER_MS });
  return accessToken;
}

// v2.65: reusa el rol ya chequeado para este invitado+álbum si sigue
// vigente — ver "Cachés en memoria" arriba. Solo cachea un resultado
// POSITIVO; un `null` (denegado de verdad, o un error de Drive que
// guestRole() ya trata como denegado por el mismo criterio fail-closed de
// siempre) nunca se cachea, para no extender una falla transitoria en una
// ventana de rechazo — y para que revocar el acceso real, una vez que la
// caché expira y se vuelve a chequear, se refleje al toque.
async function getGuestRoleCached(folderDriveId, guestEmail, ownerAccessToken) {
  const key = `${guestEmail.toLowerCase()}:${folderDriveId}`;
  const cached = guestPermissionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.role;
  const role = await guestRole(folderDriveId, guestEmail, ownerAccessToken);
  if (role) guestPermissionCache.set(key, { role, expiresAt: Date.now() + GUEST_PERMISSION_TTL_MS });
  else guestPermissionCache.delete(key);
  return role;
}

// v2.70 (Paso 2): resuelve el rol de un Contribuidor consultando
// `shared_album_members` — nunca cacheado por ahora (una sola lectura
// indexada, barata; se puede sumar al mismo esquema de caché de arriba
// más adelante si hace falta, mismo criterio "paso a paso" de siempre).
// Devuelve `null` si esta cuenta no es Contribuidor de este álbum — en ese
// caso el caller cae al chequeo de permisos reales de Drive.
async function getContributorRole(supabase, folderDriveId, guestGoogleSub) {
  const { data, error } = await supabase
    .from('shared_album_members')
    .select('role')
    .eq('folder_drive_id', folderDriveId)
    .eq('guest_google_sub', guestGoogleSub)
    .maybeSingle();
  if (error) { console.error('shared-album-proxy contributor lookup error:', error); return null; }
  return data ? data.role : null;
}

async function driveFetch(url, accessToken) {
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

// v2.62: devuelve el rol real (`'reader'`/`'writer'`/...) en vez de solo
// true/false — lectura sigue aceptando cualquier rol, escritura exige uno
// de EDITOR_ROLES (chequeado en el handler principal).
const EDITOR_ROLES = new Set(['owner', 'organizer', 'fileOrganizer', 'writer']);
// v2.67: shareFolder suma a la lista — ver el comentario grande al
// principio del archivo, sección v2.67. v2.70: las dos acciones nuevas de
// Contribuidor también pasan por este gate (aunque su propio subconjunto
// permitido — CONTRIBUTOR_WRITE_ACTIONS — sea más chico).
const WRITE_ACTIONS = new Set(['getOrCreateFolder', 'uploadMedia', 'writeJson', 'trashFile', 'shareFolder', 'contributorAppendMedia', 'contributorTrashOwnMedia']);

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

async function dispatchAction(action, params, folderDriveId, ownerAccessToken, res, guestGoogleSub) {
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

  // v2.64: metadata pura del álbum (nombre/fechas/portada), leída del
  // albums.json REAL de la dueña en vez de la copia que el invitado cachea
  // una sola vez en su propio shared-albums.json al unirse — esa copia
  // nunca se refrescaba después, así que si la dueña editaba el álbum
  // (fechas, nombre) o si al momento de compartir todavía no tenía fecha
  // de fin, el invitado quedaba con datos viejos/incompletos para
  // siempre (bug real reportado). albums.json vive en la RAÍZ del Drive
  // de la dueña — fuera del árbol de folderDriveId — así que no pasa por
  // isDescendant(); la autorización acá es folderDriveId en sí, ya
  // validado por guestRole() antes de llegar a dispatchAction(), y solo
  // se devuelve la ÚNICA entrada que corresponde a este álbum puntual
  // (nunca la lista completa — no filtra el resto de los álbumes de la
  // dueña a un invitado).
  if (action === 'getAlbumMeta') {
    const fr = await driveFetch(`https://www.googleapis.com/drive/v3/files/${folderDriveId}?fields=id,name,parents`, ownerAccessToken);
    if (!fr.ok) { res.status(502).json({ error: 'drive_error' }); return; }
    const folder = await fr.json();
    const rootId = (folder.parents || [])[0];
    if (!rootId) { res.status(200).json({ meta: null }); return; }
    let albumsFileId = await driveFindByName(rootId, ALBUMS_JSON_NAME, ownerAccessToken);
    if (!albumsFileId) {
      for (const oldName of ALBUMS_JSON_OLD_NAMES) {
        albumsFileId = await driveFindByName(rootId, oldName, ownerAccessToken);
        if (albumsFileId) break;
      }
    }
    if (!albumsFileId) { res.status(200).json({ meta: null }); return; }
    const ar = await driveFetch(`https://www.googleapis.com/drive/v3/files/${albumsFileId}?alt=media`, ownerAccessToken);
    if (!ar.ok) { res.status(200).json({ meta: null }); return; }
    let albumsJson;
    try { albumsJson = await ar.json(); } catch { res.status(200).json({ meta: null }); return; }
    const entry = (albumsJson.albums || []).find(a => a.id === folder.name);
    if (!entry) { res.status(200).json({ meta: null }); return; }
    res.status(200).json({ meta: {
      name: entry.name || folder.name,
      dateFrom: entry.dateFrom || null,
      dateTo: entry.dateTo || null,
      coverFileId: entry.coverFileId || null,
    } });
    return;
  }

  // v2.68: metadata liviana de una foto (ancho/alto reales) — la usa el
  // fotolibro PERSONAL de un invitado (ver CLAUDE.md → "Fotolibro
  // personal por invitado") para el aviso de "esta foto se va a ver
  // borrosa impresa", sin descargar el archivo completo solo para leer
  // sus dimensiones (mismo espíritu que getImageDimensions() del lado del
  // cliente, ver drive.js). Acción de LECTURA — cualquier rol (viewer
  // incluido) puede consultarla, igual que getFileJson/getMediaBytes.
  if (action === 'getImageMeta') {
    const fileId = params.fileId;
    if (!fileId || !(await isDescendant(fileId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=imageMediaMetadata(width,height)`, ownerAccessToken);
    if (!dr.ok) { res.status(404).json({ error: 'not_found' }); return; }
    const data = await dr.json();
    const meta = data.imageMediaMetadata || {};
    res.status(200).json({ width: meta.width || null, height: meta.height || null });
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

  // v2.67: un invitado EDITOR comparte el álbum con una persona más — el
  // mismo límite de drive.file que bloqueaba lectura/escritura de contenido
  // aplica acá también, dado vuelta: el token del invitado nunca puede
  // llamar permissions.create sobre una carpeta que no creó él mismo
  // (aunque sea editor). Se usa el token de la DUEÑA, igual que el resto
  // de las acciones de escritura — mismo pedido que ya hace
  // shareAlbumWithUser() (drive.js) para el camino de la dueña, solo que
  // acá el `ownerAccessToken` es el minteado del refresh_token guardado,
  // no el de quien hace el pedido.
  if (action === 'shareFolder') {
    const { guestEmail, role } = params;
    if (!guestEmail || !['reader', 'writer'].includes(role)) { res.status(400).json({ error: 'bad_request' }); return; }
    const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${folderDriveId}/permissions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, type: 'user', emailAddress: guestEmail, sendNotificationEmail: false }),
    });
    if (!pr.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(pr) }); return; }
    res.status(200).json({ ok: true });
    return;
  }

  // v2.82: "updateAlbumMeta" (un invitado editor corrigiendo nombre/fechas
  // del álbum) se sacó — el usuario decidió que renombrar/cambiar fechas
  // quede exclusivo de la dueña real, igual que archivar/eliminar. Ver
  // "Ver en Drive + 'Editar álbum' deja de ofrecerse a invitados" en
  // CLAUDE.md.

  // ── Contribuidor (v2.70, Paso 2 — ver el comentario grande al principio
  // del archivo, sección "Rol Contribuidor") ──

  // Agrega UNA entrada de media a day.json sin aceptar nunca el contenido
  // completo del archivo de parte del cliente (a diferencia de `writeJson`,
  // reservada a Lector/Co-propietario) — el servidor lee el day.json real
  // (o arranca uno default si todavía no existe), le agrega la entrada
  // marcada con `uploadedBy`, y recién ahí lo escribe. Así un Contribuidor
  // nunca puede pisar el título/notas del día ni la caption de una foto
  // ajena, mande lo que mande en el body.
  if (action === 'contributorAppendMedia') {
    const { parentId, newName, oldNames, media } = params;
    if (!parentId || !newName || !media || !media.driveFileId || !media.type || !media.name) { res.status(400).json({ error: 'bad_request' }); return; }
    if (!(await isDescendant(parentId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }
    if (!(await isDescendant(media.driveFileId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }

    let existingId = await driveFindByName(parentId, newName, ownerAccessToken);
    if (!existingId) {
      for (const oldName of (Array.isArray(oldNames) ? oldNames : (oldNames ? [oldNames] : []))) {
        existingId = await driveFindByName(parentId, oldName, ownerAccessToken);
        if (existingId) break;
      }
    }
    let dayJson = null;
    if (existingId) {
      const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files/${existingId}?alt=media`, ownerAccessToken);
      if (dr.ok) { try { dayJson = await dr.json(); } catch { dayJson = null; } }
    }
    if (!dayJson || typeof dayJson !== 'object') dayJson = { version: 2, title: '', notes: '', media: [] };
    if (!Array.isArray(dayJson.media)) dayJson.media = [];
    dayJson.media.push({
      type: media.type,
      name: media.name,
      driveFileId: media.driveFileId,
      caption: '',
      uploadedBy: guestGoogleSub,
    });

    const buf = Buffer.from(JSON.stringify(dayJson, null, 2), 'utf8');
    const ur = await driveUploadMultipart(existingId, newName, parentId, null, buf, 'application/json', ownerAccessToken);
    if (!ur.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(ur) }); return; }
    const file = await ur.json();
    res.status(200).json({ id: file.id });
    return;
  }

  // Borra una foto/video/audio SOLO si fue el propio Contribuidor quien la
  // subió — valida contra el `uploadedBy` guardado en el day.json real
  // antes de tocar nada (nunca confía en que el cliente le pida borrar
  // "lo suyo" sin confirmarlo del lado del servidor).
  if (action === 'contributorTrashOwnMedia') {
    const { fileId, parentId, newName, oldNames } = params;
    if (!fileId || !parentId || !newName) { res.status(400).json({ error: 'bad_request' }); return; }
    if (!(await isDescendant(fileId, folderDriveId, ownerAccessToken))) { res.status(403).json({ error: 'not_authorized' }); return; }

    let existingId = await driveFindByName(parentId, newName, ownerAccessToken);
    if (!existingId) {
      for (const oldName of (Array.isArray(oldNames) ? oldNames : (oldNames ? [oldNames] : []))) {
        existingId = await driveFindByName(parentId, oldName, ownerAccessToken);
        if (existingId) break;
      }
    }
    if (!existingId) { res.status(404).json({ error: 'day_not_found' }); return; }
    const dr = await driveFetch(`https://www.googleapis.com/drive/v3/files/${existingId}?alt=media`, ownerAccessToken);
    if (!dr.ok) { res.status(404).json({ error: 'day_not_found' }); return; }
    let dayJson;
    try { dayJson = await dr.json(); } catch { res.status(502).json({ error: 'invalid_json' }); return; }
    const media = Array.isArray(dayJson.media) ? dayJson.media : [];
    const idx = media.findIndex(m => m.driveFileId === fileId);
    if (idx === -1) { res.status(404).json({ error: 'media_not_found' }); return; }
    if (media[idx].uploadedBy !== guestGoogleSub) { res.status(403).json({ error: 'not_own_upload' }); return; }

    const pr = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${ownerAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
    if (!pr.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(pr) }); return; }

    media.splice(idx, 1);
    dayJson.media = media;
    const buf = Buffer.from(JSON.stringify(dayJson, null, 2), 'utf8');
    const ur = await driveUploadMultipart(existingId, newName, parentId, null, buf, 'application/json', ownerAccessToken);
    if (!ur.ok) { res.status(502).json({ error: 'drive_error', detail: await driveErrorDetail(ur) }); return; }
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
