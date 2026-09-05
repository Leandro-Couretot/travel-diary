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
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
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
async function uploadFile(blob, name, folderId, existingId = null) {
  const meta = { name };
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

// ─── ALBUMS ──────────────────────────────────────────────

// albums.json lives at root: { albums: [ { id, name, dateFrom, dateTo, coverFileId } ] }
async function loadAlbums() {
  if (!isDriveConnected()) return [];
  const fileId = await findFileInFolder('albums.json', rootFolderId);
  if (!fileId) return [];
  try {
    const data = await readJsonFile(fileId);
    return data.albums || [];
  } catch { return []; }
}

async function saveAlbums(albums) {
  await writeJsonFile({ version: 1, albums }, 'albums.json', rootFolderId);
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
  const fileId = await findFileInFolder('book.json', albumFolderId);
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
  await writeJsonFile({ version: 2, pages, drawer }, 'book.json', albumFolderId);
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
        item.driveFileId = await uploadFile(blob, item.name, dayFolderId);
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
  await writeJsonFile(dayJson, 'day.json', dayFolderId);
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
    const jsonId = await findFileInFolder('day.json', dayFolderId);
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
  const fileId = await findFileInFolder('shared-albums.json', rootFolderId);
  if (!fileId) return { version: 1, sharedAlbums: [] };
  try {
    const data = await readJsonFile(fileId);
    return { version: 1, sharedAlbums: [], ...data };
  } catch { return { version: 1, sharedAlbums: [] }; }
}

async function saveSharedAlbums(data) {
  await writeJsonFile(data, 'shared-albums.json', rootFolderId);
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
  imgEl.onload = () => imgEl.classList.remove('auth-img-loading');
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
