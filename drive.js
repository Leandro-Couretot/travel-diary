// ─── DRIVE CONFIG ────────────────────────────────────────
const DRIVE_CLIENT_ID = '29099211489-421jp27om456sbegj4qhcohvimkfbd5m.apps.googleusercontent.com';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const ROOT_FOLDER     = 'travel-diary';
const SCOPE_VERSION   = 4; // bumped: + userinfo.email (identidad estable para suscripciones)

// ─── STATE ───────────────────────────────────────────────
let driveToken       = null;
let rootFolderId     = null;
let _onConnected     = null;
let _onFailure       = null;
let pendingAuthState = null; // anti-CSRF: state mandado en el último pedido de acceso (ver app.html)

// ─── INIT ────────────────────────────────────────────────
// El armado de tokenClient (google.accounts.oauth2.initTokenClient) y el
// botón "Conectar Drive" viven en app.html (initGoogleAuth/handleDriveBtn) —
// initDrive() solo se encarga de restaurar una sesión ya guardada.
function initDrive(onConnectedCallback, onFailureCallback) {
  _onConnected = onConnectedCallback;
  _onFailure   = onFailureCallback || null;
  const savedScope = parseInt(localStorage.getItem('scope_version') || '0');
  if (savedScope < SCOPE_VERSION) {
    localStorage.removeItem('drive_token');
    localStorage.setItem('scope_version', String(SCOPE_VERSION));
  }
  const saved = localStorage.getItem('drive_token');
  if (saved) { driveToken = saved; _bootstrapDrive(); }
}

async function _bootstrapDrive() {
  try {
    rootFolderId = await getOrCreateFolder(ROOT_FOLDER, 'root');
    if (_onConnected) await _onConnected();
  } catch(e) {
    console.warn('Drive bootstrap error:', e);
    driveToken = null; rootFolderId = null;
    localStorage.removeItem('drive_token');
    if (_onFailure) _onFailure();
  }
}

function disconnectDrive() {
  driveToken = null; rootFolderId = null;
  localStorage.removeItem('drive_token');
}

function isDriveConnected() {
  return !!(driveToken && rootFolderId);
}

// ─── ERROR HANDLING (ver ERROR_HANDLING_PLAN.md) ─────────
// Errores de Drive que la UI necesita distinguir de un fallo genérico
// (chequeado contra el shape real: error.code=403, error.errors[].reason
// = 'storageQuotaExceeded'; se agrega un chequeo por substring del
// mensaje como red de contención por si Google cambia el formato).
class DriveQuotaExceededError extends Error {
  constructor() {
    super('Tu Google Drive se quedó sin espacio. Liberá lugar o ampliá tu almacenamiento en Google, y volvé a intentar.');
    this.name = 'DriveQuotaExceededError';
  }
}

async function _driveErrorBody(res) {
  try { return (await res.clone().json()).error || null; } catch { return null; }
}

function _isQuotaExceeded(errorInfo) {
  if (!errorInfo) return false;
  if (errorInfo.errors?.some(e => e.reason === 'storageQuotaExceeded')) return true;
  return /storage quota/i.test(errorInfo.message || '');
}

// ─── CORE REQUEST ────────────────────────────────────────
const DRIVE_MAX_RETRIES = 3;

async function driveReq(method, url, body) {
  const headers = { 'Authorization': `Bearer ${driveToken}` };
  const opts = { method, headers };
  const isUpload = body instanceof FormData;
  if (isUpload) {
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  // Subidas de archivo pueden tardar de verdad en una conexión lenta — se les
  // da más margen antes de considerar el pedido colgado que a un JSON chico.
  const timeoutMs = isUpload ? 120000 : 20000;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...opts, signal: controller.signal });
    } catch (err) {
      // v1.31: sin esto, un fetch que ni resuelve ni falla (conexión
      // inestable) dejaba la promesa colgada para siempre — el botón se
      // quedaba en "Guardando..." sin ningún aviso ni forma de reintentar.
      if (attempt >= DRIVE_MAX_RETRIES) {
        throw new Error(err.name === 'AbortError' ? 'La conexión con Drive tardó demasiado. Probá de nuevo.' : err.message);
      }
      await new Promise(r => setTimeout(r, (2 ** attempt) * 500 + Math.random() * 250));
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) {
      driveToken = null; rootFolderId = null;
      localStorage.removeItem('drive_token');
      throw new Error('Token expirado — reconectá Drive');
    }
    const isRetryable = res.status === 429 || res.status >= 500;
    if (!isRetryable || attempt >= DRIVE_MAX_RETRIES) return res;
    const retryAfter = parseFloat(res.headers.get('Retry-After'));
    const delay = !isNaN(retryAfter) ? retryAfter * 1000 : (2 ** attempt) * 500 + Math.random() * 250;
    await new Promise(r => setTimeout(r, delay));
  }
}

// ─── FOLDER HELPERS ──────────────────────────────────────
async function getOrCreateFolder(name, parentId) {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`);
  const data = await res.json();
  if (data.files && data.files.length) return data.files[0].id;
  const create = await driveReq('POST', 'https://www.googleapis.com/drive/v3/files',
    { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] });
  const folder = await create.json();
  return folder.id;
}

async function listFolders(parentId) {
  const q = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&orderBy=name`);
  const data = await res.json();
  return data.files || [];
}

// Archivos (no carpetas) dentro de una carpeta — usado para reconstruir
// un día cuando su day.json se borró pero las fotos/videos siguen ahí
// (ver ERROR_HANDLING_PLAN.md Caso 3).
async function listFilesInFolder(folderId) {
  const q = `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`);
  const data = await res.json();
  return data.files || [];
}

async function findFileInFolder(name, folderId) {
  const q = `name='${name}' and '${folderId}' in parents and trashed=false`;
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

// ─── DAY CACHE ───────────────────────────────────────────
// Cachea folderId + contenido de day.json por álbum+fecha para que
// Lista, Mes y Libro no vuelvan a pedirle a Drive lo mismo una y otra
// vez. Clave por albumFolderId además de la fecha: dos álbumes
// distintos pueden tener un día con el mismo nombre (YYYY-MM-DD).
const _dayCache = {};

function _dayKey(albumFolderId, dateStr) { return `${albumFolderId}::${dateStr}`; }

function invalidateDayCache(albumFolderId, dateStr) {
  delete _dayCache[_dayKey(albumFolderId, dateStr)];
}

async function listDayFolders(albumFolderId) {
  const folders = await listFolders(albumFolderId);
  // Filter to date-shaped folders only (YYYY-MM-DD)
  const dayFolders = folders.filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f.name));
  // Ya tenemos el id de cada carpeta acá — cachearlo para no tener
  // que volver a buscarlo por nombre en loadDayFromDrive.
  dayFolders.forEach(f => {
    const key = _dayKey(albumFolderId, f.name);
    _dayCache[key] = { ..._dayCache[key], folderId: f.id };
  });
  return dayFolders.map(f => f.name).sort();
}

// ─── FILE HELPERS ────────────────────────────────────────
async function uploadFile(blob, name, folderId, existingId = null, description = null) {
  const meta = { name };
  if (description) meta.description = description;
  if (!existingId) meta.parents = [folderId];
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);
  const url = existingId
    ? `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
  const res = await driveReq(existingId ? 'PATCH' : 'POST', url, form);
  if (!res.ok) {
    const errInfo = await _driveErrorBody(res);
    if (_isQuotaExceeded(errInfo)) throw new DriveQuotaExceededError();
    throw new Error(errInfo?.message || 'No se pudo subir el archivo a Drive');
  }
  const file = await res.json();
  return file.id;
}

async function readJsonFile(fileId) {
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return await res.json();
}

// Pese al nombre (que mantenemos por compatibilidad con los callers),
// devuelve un blob: URL en vez de un data: URL en base64 — mismo uso
// (asignable a src de <video>/<audio>/<img>, o a fetch()), sin el ~33%
// de overhead de base64 ni el bloqueo del hilo principal codificando.
// Quien lo use debe revocarlo con URL.revokeObjectURL() cuando ya no
// lo necesite.
async function fetchFileAsDataUrl(fileId) {
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  if (!res.ok) throw new Error('Este archivo ya no está disponible en Drive');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

function base64ToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function writeJsonFile(obj, name, folderId) {
  const existingId = await findFileInFolder(name, folderId);
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  return await uploadFile(blob, name, folderId, existingId);
}

// ─── NOMENCLATURA DE ARCHIVOS DE LA APP ──────────────────
// Los archivos que crea la app en Drive llevan el prefijo "[Travel
// Diary]" para que se puedan identificar de un vistazo (ej. en la
// vista "Recientes" de Drive, donde aparecen sueltos sin la carpeta
// que les da contexto) y no se borren por accidente pensando que son
// basura. Migración deliberadamente lazy: NO se renombran en bloque
// los archivos ya existentes con el nombre viejo — se siguen
// reconociendo (findFileInFolderMigrating) y recién se renombran la
// próxima vez que ese archivo puntual se escribe
// (writeJsonFileMigrating), mismo criterio que ya se usó para migrar
// book.json v1→v2.
const APP_NAME_PREFIX = '[Travel Diary]';

// Busca primero con el nombre nuevo; si no aparece, cae al nombre viejo
// (archivo creado antes de este cambio, todavía sin migrar).
async function findFileInFolderMigrating(newName, oldName, folderId) {
  const id = await findFileInFolder(newName, folderId);
  if (id) return id;
  return await findFileInFolder(oldName, folderId);
}

// Escribe con el nombre nuevo. Si ya existe un archivo con el nombre
// nuevo lo actualiza; si no, pero existe uno con el nombre viejo, lo
// actualiza Y renombra en el mismo pedido (uploadFile hace PATCH del
// name además del contenido); si no existe ninguno, crea uno nuevo.
async function writeJsonFileMigrating(obj, newName, oldName, folderId, description) {
  let existingId = await findFileInFolder(newName, folderId);
  if (!existingId) existingId = await findFileInFolder(oldName, folderId);
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  return await uploadFile(blob, newName, folderId, existingId, description);
}

const ALBUMS_JSON_NAME = `${APP_NAME_PREFIX} - Mis álbumes.json`;
const ALBUMS_JSON_OLD_NAME = 'albums.json';
const ALBUMS_JSON_DESCRIPTION = 'Este archivo es usado por la app Travel Diary — es el índice de todos tus álbumes. Borrarlo no borra tus fotos, pero hace que la app deje de encontrarlas hasta que se reconstruya solo.';

const SHARED_ALBUMS_JSON_NAME = `${APP_NAME_PREFIX} - Álbumes compartidos.json`;
const SHARED_ALBUMS_JSON_OLD_NAME = 'shared-albums.json';
const SHARED_ALBUMS_JSON_DESCRIPTION = 'Este archivo es usado por la app Travel Diary — es la lista de álbumes que otras personas compartieron con vos. Borrarlo no afecta tus propios álbumes.';

const BOOK_JSON_NAME = `${APP_NAME_PREFIX} - Fotolibro.json`;
const BOOK_JSON_OLD_NAME = 'book.json';
const BOOK_JSON_DESCRIPTION = 'Este archivo es usado por la app Travel Diary — guarda el orden manual del fotolibro de este álbum. Borrarlo no borra ninguna foto, solo se pierde el orden elegido.';

function dayJsonName(dateStr) { return `${APP_NAME_PREFIX} - Día ${dateStr}.json`; }
const DAY_JSON_OLD_NAME = 'day.json';
const DAY_JSON_DESCRIPTION = 'Este archivo es usado por la app Travel Diary. Borrarlo puede hacer que pierdas el título/notas de este día (las fotos no se pierden).';

async function findDayJsonId(dayFolderId, dateStr) {
  return await findFileInFolderMigrating(dayJsonName(dateStr), DAY_JSON_OLD_NAME, dayFolderId);
}
async function saveDayJson(dayFolderId, dateStr, dayJson) {
  return await writeJsonFileMigrating(dayJson, dayJsonName(dateStr), DAY_JSON_OLD_NAME, dayFolderId, DAY_JSON_DESCRIPTION);
}

const MEDIA_KIND_LABELS = { image: 'foto', video: 'video', audio: 'audio' };
const MEDIA_FILE_DESCRIPTION = 'Este archivo es una foto/video/audio de tu diario en la app Travel Diary.';
function mediaFileName(kind, originalName) {
  return `${APP_NAME_PREFIX} - ${MEDIA_KIND_LABELS[kind] || kind} - ${originalName}`;
}

// ─── ALBUMS ──────────────────────────────────────────────

// albums.json lives at root: { albums: [ { id, name, dateFrom, dateTo, coverFileId } ] }
async function loadAlbums() {
  if (!isDriveConnected()) return [];
  const fileId = await findFileInFolderMigrating(ALBUMS_JSON_NAME, ALBUMS_JSON_OLD_NAME, rootFolderId);
  if (fileId) {
    try {
      const data = await readJsonFile(fileId);
      if (data.albums) return data.albums;
    } catch {}
  }
  // albums.json no existe o no se pudo leer — pero las carpetas de cada
  // álbum (con sus días y fotos) pueden seguir 100% intactas en Drive.
  // En vez de mostrar "no tenés álbumes" con el contenido real todavía
  // ahí, se reconstruye el índice escaneando esas carpetas (mismo
  // criterio que la reconstrucción de day.json — ver CLAUDE.md). Se
  // pierden las fechas manuales (solo vivían en el JSON borrado) y el
  // nombre queda aproximado desde el slug de la carpeta, pero ningún
  // álbum desaparece.
  const reconstructed = await reconstructAlbumsFromFolders();
  if (reconstructed.length) {
    await saveAlbums(reconstructed.map(({ _reconstructed, ...a }) => a));
  }
  return reconstructed;
}

async function reconstructAlbumsFromFolders() {
  const folders = await listFolders(rootFolderId);
  // Las carpetas con nombre de fecha son días sueltos de la estructura
  // plana vieja (pre-álbumes, ver migrateOldDaysToAlbum) — no álbumes.
  const albumFolders = folders.filter(f => !/^\d{4}-\d{2}-\d{2}$/.test(f.name));
  return albumFolders.map(f => ({
    id: f.name,
    name: prettifyFolderName(f.name),
    dateFrom: null, dateTo: null, coverFileId: null,
    _reconstructed: true,
  }));
}

function prettifyFolderName(slug) {
  return slug.split('-').map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
}

async function saveAlbums(albums) {
  await writeJsonFileMigrating({ version: 1, albums }, ALBUMS_JSON_NAME, ALBUMS_JSON_OLD_NAME, rootFolderId, ALBUMS_JSON_DESCRIPTION);
}

async function createAlbum(album) {
  // album: { id, name, dateFrom, dateTo }
  const albums = await loadAlbums();
  if (albums.find(a => a.id === album.id)) throw new Error('Ya existe un álbum con ese ID');
  await getOrCreateFolder(album.id, rootFolderId);
  albums.push({ ...album, coverFileId: null });
  await saveAlbums(albums);
  return album;
}

async function updateAlbumMeta(albumId, patch) {
  const albums = await loadAlbums();
  const idx = albums.findIndex(a => a.id === albumId);
  if (idx < 0) throw new Error('Álbum no encontrado');
  albums[idx] = { ...albums[idx], ...patch };
  await saveAlbums(albums);
  return albums[idx];
}

async function getAlbumFolderId(albumId) {
  if (!rootFolderId) throw new Error('rootFolderId no disponible todavía');
  return await getOrCreateFolder(albumId, rootFolderId);
}

// Cuenta cuántos álbumes puede editar el usuario actual DESDE LA APP —
// usado para el límite de álbumes gratis (ver CLAUDE.md → "Suscripciones").
// Cuenta: álbumes propios activos (no archivados) + álbumes compartidos
// donde el usuario es editor AHORA MISMO (rol real de Drive, consultado
// en vivo con canEditFolder — shared-albums.json no guarda el rol, así
// que no se puede cachear). Los archivados y los compartidos donde solo
// puede ver no cuentan — evita que alguien junte cupo gratis en varias
// cuentas compartiéndose álbumes de solo lectura entre sí.
async function countEditableAlbums() {
  const [ownAlbums, sharedData] = await Promise.all([loadAlbums(), loadSharedAlbums()]);
  const ownActiveCount = ownAlbums.filter(a => !a.archived).length;
  const sharedAlbums = sharedData.sharedAlbums || [];
  const canEditFlags = await Promise.all(sharedAlbums.map(a => canEditFolder(a.folderDriveId)));
  const sharedEditableCount = canEditFlags.filter(Boolean).length;
  return ownActiveCount + sharedEditableCount;
}

// Un álbum propio es "elegible gratis" si está entre los primeros
// `freeLimit` creados (orden de `albums.json`, nunca se reordena salvo
// que se elimine uno) que TODAVÍA existen — no importa si está activo o
// archivado, solo su posición de creación. Deliberadamente por
// IDENTIDAD y no por cantidad activa en este momento: si fuera por
// cantidad, un usuario gratis podría alternar cuál archiva/reactiva y
// terminar editando más de `freeLimit` álbumes con el tiempo sin pagar
// nunca — cada vez que "libera" un lugar archivando uno, reactiva otro.
// Con este criterio, archivar un álbum de los primeros `freeLimit`
// nunca le cede el lugar a uno más nuevo (sigue ocupando su posición);
// solo **eliminarlo** de verdad corre a los demás y deja entrar al
// siguiente.
function isFreeEligibleAlbum(albums, albumId, freeLimit) {
  const idx = albums.findIndex(a => a.id === albumId);
  return idx !== -1 && idx < freeLimit;
}

// Aplica el downgrade automático (Paso 4 del modelo freemium — ver
// CLAUDE.md → "Suscripciones"): si el usuario ya NO es Pro, archiva
// cualquier álbum propio activo que no sea "elegible gratis" (ver
// isFreeEligibleAlbum) marcándolo con `archivedByDowngrade:true` —
// reusa el archivado del Paso 1, misma experiencia ("Archivados" + link
// a Drive), solo que disparada sola en vez de a mano. Si el usuario SÍ
// es Pro, desarchiva automáticamente SOLO los álbumes con ese flag —
// nunca uno que el usuario archivó a mano (esos no tienen el flag, así
// que no se tocan). Devuelve true si cambió algo (para que el llamador
// sepa si hace falta re-renderizar Home).
async function enforceAlbumLimit(isPaid, freeLimit) {
  const albums = await loadAlbums();
  let changed = false;
  if (isPaid) {
    albums.forEach(a => {
      if (a.archivedByDowngrade) { a.archived = false; a.archivedByDowngrade = false; changed = true; }
    });
  } else {
    albums.forEach((a, idx) => {
      if (!a.archived && idx >= freeLimit) { a.archived = true; a.archivedByDowngrade = true; changed = true; }
    });
  }
  if (changed) await saveAlbums(albums);
  return changed;
}

// Elimina un álbum propio de verdad: manda la carpeta completa (con todo
// su contenido) a la papelera de Drive (trashed:true, recuperable 30 días
// desde Drive — mismo criterio que archivos individuales desde v1.9) y
// saca la entrada de albums.json. A diferencia de archivar, esto sí
// compromete el contenido — el llamador debe confirmar explícitamente
// con el usuario antes de invocarla.
async function deleteAlbum(albumId) {
  const albums = await loadAlbums();
  const idx = albums.findIndex(a => a.id === albumId);
  if (idx < 0) throw new Error('Álbum no encontrado');
  const folderId = await getAlbumFolderId(albumId);
  await driveReq('PATCH', `https://www.googleapis.com/drive/v3/files/${folderId}`, { trashed: true });
  albums.splice(idx, 1);
  await saveAlbums(albums);
}

// Saca un álbum compartido de la propia lista (shared-albums.json) — NO
// revoca el permiso real que dio el dueño en Drive, solo deja de
// aparecer en el Home de este usuario. El dueño puede seguir viendo que
// el permiso sigue activo del lado de Drive; si de verdad quiere cortar
// el acceso, tiene que sacarlo desde el panel de compartir de la carpeta.
async function leaveSharedAlbum(folderDriveId) {
  const stored = await loadSharedAlbums();
  stored.sharedAlbums = stored.sharedAlbums.filter(a => a.folderDriveId !== folderDriveId);
  await saveSharedAlbums(stored);
}

// Consulta a Drive si el usuario actual puede editar esta carpeta
// (rol writer) o solo verla (rol reader). Se usa para álbumes
// compartidos, donde el rol puede ser cualquiera de los dos — para
// álbumes propios no hace falta llamarla, siempre es true.
async function canEditFolder(folderId) {
  try {
    const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files/${folderId}?fields=capabilities(canEdit)`);
    if (!res.ok) return true; // ante la duda, no romper la UI de quien sí puede editar
    const data = await res.json();
    return data.capabilities?.canEdit !== false;
  } catch {
    return true;
  }
}

// Nombres de archivo ya guardados en el day.json de una fecha — usado
// por la carga masiva para avisar de posibles duplicados antes de subir
// (comparación por nombre, no por contenido; ver CLAUDE.md →
// "Aviso de posibles duplicados en carga masiva").
async function getExistingNamesForDate(albumFolderId, dateStr) {
  const day = await loadDayFromDrive(albumFolderId, dateStr);
  return new Set((day?.media || []).map(m => m.name));
}

// ─── FOTOLIBRO: páginas explícitas + drawer ──────────────
// book.json vive en la raíz de la carpeta del álbum (no en un día
// puntual). v2 guarda páginas explícitas — cada una con su lista de
// fotos (por driveFileId) y un layout opcional forzado — más un
// "drawer" de fotos sin ubicar todavía (no entran al libro final,
// pero tampoco se pierden: el usuario decide después qué hacer con
// ellas). El resto de los datos (fecha, caption) se resuelve contra
// los day.json de siempre — así el fotolibro queda independiente de
// la fecha de cada foto (ver CLAUDE.md → "Fotolibro: páginas
// explícitas + drawer").
//
// Migra sola desde el v1 (array plano `order`, de versiones
// anteriores): se agrupa de a 4 en el mismo orden que ya se veía,
// drawer vacío — no se pierde ni se reordena nada existente.
async function loadBookLayout(albumFolderId) {
  const fileId = await findFileInFolderMigrating(BOOK_JSON_NAME, BOOK_JSON_OLD_NAME, albumFolderId);
  if (!fileId) return null;
  const data = await readJsonFile(fileId);
  if (Array.isArray(data?.pages)) {
    return { pages: data.pages, drawer: Array.isArray(data.drawer) ? data.drawer : [] };
  }
  if (Array.isArray(data?.order)) {
    const pages = [];
    for (let i = 0; i < data.order.length; i += 4) pages.push({ images: data.order.slice(i, i + 4), layout: null });
    return { pages, drawer: [], _migrated: true };
  }
  return null;
}

async function saveBookLayout(albumFolderId, { pages, drawer }) {
  await writeJsonFileMigrating({ version: 2, pages, drawer }, BOOK_JSON_NAME, BOOK_JSON_OLD_NAME, albumFolderId, BOOK_JSON_DESCRIPTION);
}

// ─── DAY OPERATIONS ──────────────────────────────────────

async function saveDayToDrive(albumFolderId, dateStr, day, previousIds = null) {
  if (!albumFolderId) throw new Error('albumFolderId no disponible — esperá a que Drive termine de cargar');
  const dayFolderId = await getOrCreateFolder(dateStr, albumFolderId);
  // Si un archivo falla (cuota excedida, se minimizó la app a mitad de
  // subida, etc.) no se aborta todo el guardado — se sigue con el resto
  // y al final se persiste igual lo que sí llegó a Drive (mismo criterio
  // que runBulkUpload en app.html; ver ERROR_HANDLING_PLAN.md).
  const failedItems = [];
  for (const item of day.media) {
    if (!item.driveFileId) {
      let blob;
      if (item._file) {
        // Video: use original File object directly
        blob = item._file;
      } else if (item.data && item.data.startsWith('data:')) {
        blob = base64ToBlob(item.data);
      } else {
        continue; // blob URL or no data — skip
      }
      try {
        item.driveFileId = await uploadFile(blob, mediaFileName(item.type, item.name), dayFolderId, null, MEDIA_FILE_DESCRIPTION);
        if (item._file) {
          // Replace blob URL with Drive thumbnail reference, free memory
          URL.revokeObjectURL(item.data);
          delete item.data;
          delete item._file;
        }
      } catch (e) {
        failedItems.push(e); // item.data/_file quedan intactos para poder reintentar
      }
    }
  }
  if (previousIds) {
    const currentIds = new Set(day.media.filter(m => m.driveFileId).map(m => m.driveFileId));
    const removedIds = [...previousIds].filter(id => !currentIds.has(id));
    for (const id of removedIds) {
      try { await driveReq('PATCH', `https://www.googleapis.com/drive/v3/files/${id}`, { trashed: true }); }
      catch (e) { console.warn('No se pudo mover a la papelera:', id, e); }
    }
  }
  const dayJson = {
    version: 2, title: day.title, notes: day.notes,
    // Los que fallaron no se incluyen acá (quedarían con driveFileId
    // null, un item "fantasma" que no se puede volver a renderizar
    // después de recargar la página) — siguen en day.media en memoria
    // para poder reintentarlos, solo no se persisten todavía.
    media: day.media.filter(m => m.driveFileId).map(m => ({
      type: m.type, name: m.name,
      driveFileId: m.driveFileId,
      caption: m.caption || ''
    }))
  };
  await saveDayJson(dayFolderId, dateStr, dayJson);
  _dayCache[_dayKey(albumFolderId, dateStr)] = { folderId: dayFolderId, json: { title: dayJson.title, notes: dayJson.notes, media: dayJson.media } };
  if (failedItems.length) {
    const isQuota = failedItems.some(e => e instanceof DriveQuotaExceededError);
    const err = new Error(isQuota
      ? 'Tu Google Drive se quedó sin espacio — se guardó lo que sí entró. Liberá lugar y tocá "Guardar" para reintentar el resto.'
      : `Se guardó lo que se pudo, pero ${failedItems.length} archivo${failedItems.length > 1 ? 's' : ''} no se pudo${failedItems.length > 1 ? 'n' : ''} subir. Tocá "Guardar" para reintentar.`);
    err.driveSaveFailedCount = failedItems.length;
    throw err;
  }
  return day;
}

function _cloneDay(day) {
  const clone = { title: day.title, notes: day.notes, media: day.media.map(m => ({ ...m })) };
  if (day._reconstructed) clone._reconstructed = true;
  return clone;
}

async function loadDayFromDrive(albumFolderId, dateStr) {
  try {
    const key = _dayKey(albumFolderId, dateStr);
    const cached = _dayCache[key];
    if (cached && cached.json) return _cloneDay(cached.json);

    let dayFolderId = cached && cached.folderId;
    if (!dayFolderId) {
      const q = `name='${dateStr}' and mimeType='application/vnd.google-apps.folder' and '${albumFolderId}' in parents and trashed=false`;
      const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
      const data = await res.json();
      if (!data.files || !data.files.length) return null;
      dayFolderId = data.files[0].id;
    }
    const jsonId = await findDayJsonId(dayFolderId, dateStr);
    let result;
    if (!jsonId) {
      // day.json no existe pero la carpeta puede seguir teniendo archivos
      // (alguien lo borró a mano desde Drive sin borrar las fotos) —
      // reconstruir lo que se pueda en vez de hacer desaparecer el día
      // entero. Título y notas no son recuperables (ver
      // ERROR_HANDLING_PLAN.md Caso 3).
      const files = await listFilesInFolder(dayFolderId);
      const media = files
        .map(f => {
          const type = f.mimeType.startsWith('image/') ? 'image'
            : f.mimeType.startsWith('video/') ? 'video'
            : f.mimeType.startsWith('audio/') ? 'audio' : null;
          return type ? { type, name: f.name, driveFileId: f.id, caption: '' } : null;
        })
        .filter(Boolean);
      if (!media.length) return null; // carpeta vacía de verdad: no hay día que mostrar
      result = { title: '', notes: '', media, _reconstructed: true };
    } else {
      const dayJson = await readJsonFile(jsonId);
      result = {
        title: dayJson.title || '',
        notes: dayJson.notes || '',
        media: (dayJson.media || []).map(m => ({
          type: m.type, name: m.name,
          driveFileId: m.driveFileId,
          caption: m.caption || ''
        }))
      };
    }
    _dayCache[key] = { folderId: dayFolderId, json: result };
    return _cloneDay(result);
  } catch(e) {
    console.warn('Error cargando día desde Drive:', e);
    return null;
  }
}

// ─── SHARING ──────────────────────────────────────────────

async function shareAlbumWithUser(albumFolderId, guestEmail, role = 'reader') {
  const res = await driveReq('POST',
    `https://www.googleapis.com/drive/v3/files/${albumFolderId}/permissions`,
    { role, type: 'user', emailAddress: guestEmail, sendNotificationEmail: false }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Error al compartir');
  }
  return await res.json();
}

function generateShareLink(folderId, name, dateFrom, dateTo) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, 'index.html');
  const p = new URLSearchParams({ join: folderId, name });
  if (dateFrom) p.set('from', dateFrom);
  if (dateTo)   p.set('to', dateTo);
  return `${base}?${p.toString()}`;
}

async function loadSharedAlbums() {
  if (!isDriveConnected()) return { version: 1, sharedAlbums: [] };
  const fileId = await findFileInFolderMigrating(SHARED_ALBUMS_JSON_NAME, SHARED_ALBUMS_JSON_OLD_NAME, rootFolderId);
  if (!fileId) return { version: 1, sharedAlbums: [] };
  try {
    const data = await readJsonFile(fileId);
    return { version: 1, sharedAlbums: [], ...data };
  } catch { return { version: 1, sharedAlbums: [] }; }
}

async function saveSharedAlbums(data) {
  await writeJsonFileMigrating(data, SHARED_ALBUMS_JSON_NAME, SHARED_ALBUMS_JSON_OLD_NAME, rootFolderId, SHARED_ALBUMS_JSON_DESCRIPTION);
}

async function joinSharedAlbum(folderDriveId, albumName, dateFrom, dateTo) {
  const stored = await loadSharedAlbums();
  if (stored.sharedAlbums.some(a => a.folderDriveId === folderDriveId)) {
    return { alreadyJoined: true };
  }
  let ownerEmail = null;
  try {
    const metaRes = await driveReq('GET',
      `https://www.googleapis.com/drive/v3/files/${folderDriveId}?fields=id,owners`
    );
    if (!metaRes.ok) throw new Error('Sin acceso');
    const meta = await metaRes.json();
    ownerEmail = meta.owners?.[0]?.emailAddress || null;
  } catch {
    throw new Error('No se pudo acceder a la carpeta. Pedile al dueño que te comparta el álbum primero.');
  }
  stored.sharedAlbums.push({
    folderDriveId, name: albumName, ownerEmail,
    dateFrom: dateFrom || null, dateTo: dateTo || null, coverFileId: null
  });
  await saveSharedAlbums(stored);
  return { alreadyJoined: false };
}

// ─── AUTHENTICATED IMAGE URLS ────────────────────────────
// Cache de blob URLs para no re-descargar imágenes
const _imgCache = {};

async function getAuthImgUrl(fileId, size = 'w800') {
  if (!fileId) return '';
  const cacheKey = `${fileId}_${size}`;
  if (_imgCache[cacheKey]) return _imgCache[cacheKey];

  // Intentar con thumbnail URL primero (más rápido, no requiere auth en browser normal)
  // Si falla (PWA/contexto aislado), caer a API autenticada
  const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=${size}`;

  // Test si la thumbnail URL funciona
  try {
    const testRes = await fetch(thumbUrl, { method: 'HEAD', mode: 'no-cors' });
    // no-cors siempre "succeeds" opaquely, así que usamos la URL directo
    // y dejamos que el <img> maneje el error via onerror
    _imgCache[cacheKey] = thumbUrl;
    return thumbUrl;
  } catch {
    // Caer a API autenticada
    return await fetchAuthImgUrl(fileId);
  }
}

async function fetchAuthImgUrl(fileId) {
  const cacheKey = `auth_${fileId}`;
  if (_imgCache[cacheKey]) return _imgCache[cacheKey];
  try {
    const res  = await driveReq('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) return ''; // borrado o sin acceso — no es un blob válido, no intentar renderizarlo
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    _imgCache[cacheKey] = url;
    return url;
  } catch(e) {
    console.warn('Error cargando imagen autenticada:', e);
    return '';
  }
}

// Placeholder visual para cuando un archivo referenciado en day.json ya no
// existe en Drive (borrado a mano por el usuario, fuera de la app — ver
// ERROR_HANDLING_PLAN.md Caso 2). Mejor que dejar el ícono roto nativo del
// navegador, que no explica qué pasó.
const MEDIA_UNAVAILABLE_SVG = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">' +
  '<rect width="200" height="200" fill="#e8e4db"/>' +
  '<text x="100" y="92" font-family="sans-serif" font-size="36" text-anchor="middle">🖼️</text>' +
  '<text x="100" y="126" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#8a8172">No disponible</text>' +
  '</svg>'
);

// Helper para img elements: intenta thumbnail, si falla usa API auth, y si
// tampoco eso funciona (el archivo ya no existe en Drive) muestra un
// placeholder en vez del ícono roto del navegador.
function setAuthImg(imgEl, fileId, size = 'w800') {
  if (!fileId || !imgEl) return;
  // Evita el ícono nativo de "imagen rota/cargando" del navegador durante el
  // instante entre insertar el <img> sin src todavía cargado y que la miniatura
  // de Drive (o su fallback) termine de llegar — se saca solo con onload, sea
  // cual sea la rama que termine resolviendo el src (ver v1.27 en CLAUDE.md).
  imgEl.classList.add('auth-img-loading');
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    clearTimeout(stuckTimer);
    imgEl.classList.remove('auth-img-loading');
  };
  imgEl.onload = reveal;
  // Red de seguridad (v1.29): en una conexión inestable el pedido puede quedar
  // colgado sin disparar load NI error nunca — sin esto la foto quedaba
  // invisible para siempre en vez de mostrar aunque sea el ícono roto (ver
  // CLAUDE.md). Si no resolvió en 8s, se muestra igual.
  const stuckTimer = setTimeout(reveal, 8000);
  const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=${size}`;
  imgEl.src = thumbUrl;
  imgEl.onerror = async () => {
    imgEl.onerror = null; // evitar loop
    const authUrl = await fetchAuthImgUrl(fileId);
    if (authUrl) {
      imgEl.src = authUrl;
    } else {
      imgEl.src = MEDIA_UNAVAILABLE_SVG;
      imgEl.title = 'Este archivo ya no está disponible en Drive';
      imgEl.classList.add('media-unavailable');
    }
  };
}


// Moves old flat structure (travel-diary/YYYY-MM-DD/) into album folder

async function migrateOldDaysToAlbum(albumId) {
  const folders = await listFolders(rootFolderId);
  const dateFolders = folders.filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f.name));
  if (!dateFolders.length) return 0;

  const albumFolderId = await getAlbumFolderId(albumId);

  for (const folder of dateFolders) {
    // Move folder: update parent via Drive API
    await driveReq('PATCH',
      `https://www.googleapis.com/drive/v3/files/${folder.id}?addParents=${albumFolderId}&removeParents=${rootFolderId}`,
      {}
    );
  }
  return dateFolders.length;
}
