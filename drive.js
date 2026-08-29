// ─── DRIVE CONFIG ────────────────────────────────────────
const DRIVE_CLIENT_ID = '29099211489-421jp27om456sbegj4qhcohvimkfbd5m.apps.googleusercontent.com';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file';
const ROOT_FOLDER     = 'travel-diary';
const SCOPE_VERSION   = 3; // bumped: drive → drive.file

// ─── STATE ───────────────────────────────────────────────
let driveToken    = null;
let rootFolderId  = null;
let tokenClient   = null;
let _onConnected  = null;
let _onFailure    = null;

// ─── INIT ────────────────────────────────────────────────
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

function initGoogleAuth() {
  try {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: async (response) => {
        if (response.error) { console.warn('Drive auth error:', response.error); return; }
        driveToken = response.access_token;
        localStorage.setItem('drive_token', driveToken);
        localStorage.setItem('scope_version', String(SCOPE_VERSION));
        await _bootstrapDrive();
      }
    });
    // Solo llama a _bootstrapDrive si initDrive() no lo hizo ya
    if (!_onConnected) {
      const saved = localStorage.getItem('drive_token');
      if (saved) { driveToken = saved; _bootstrapDrive(); }
    }
  } catch(e) {
    console.warn('Google Auth no disponible:', e);
  }
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

function requestDriveAccess() {
  if (tokenClient) tokenClient.requestAccessToken();
  else alert('Google Drive no está disponible. Chequeá tu conexión.');
}

function disconnectDrive() {
  driveToken = null; rootFolderId = null;
  localStorage.removeItem('drive_token');
}

function isDriveConnected() {
  return !!(driveToken && rootFolderId);
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
  const file = await res.json();
  return file.id;
}

async function readJsonFile(fileId) {
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return await res.json();
}

async function fetchFileAsDataUrl(fileId) {
  const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  const blob = await res.blob();
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.readAsDataURL(blob);
  });
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

// ─── DAY OPERATIONS ──────────────────────────────────────

async function saveDayToDrive(albumFolderId, dateStr, day, previousIds = null) {
  if (!albumFolderId) throw new Error('albumFolderId no disponible — esperá a que Drive termine de cargar');
  const dayFolderId = await getOrCreateFolder(dateStr, albumFolderId);
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
      item.driveFileId = await uploadFile(blob, item.name, dayFolderId);
      if (item._file) {
        // Replace blob URL with Drive thumbnail reference, free memory
        URL.revokeObjectURL(item.data);
        delete item.data;
        delete item._file;
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
    media: day.media.map(m => ({
      type: m.type, name: m.name,
      driveFileId: m.driveFileId || null,
      caption: m.caption || ''
    }))
  };
  await writeJsonFile(dayJson, 'day.json', dayFolderId);
  _dayCache[_dayKey(albumFolderId, dateStr)] = { folderId: dayFolderId, json: { title: dayJson.title, notes: dayJson.notes, media: dayJson.media } };
  return day;
}

function _cloneDay(day) {
  return { title: day.title, notes: day.notes, media: day.media.map(m => ({ ...m })) };
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
    if (!jsonId) return null;
    const dayJson = await readJsonFile(jsonId);
    const result = {
      title: dayJson.title || '',
      notes: dayJson.notes || '',
      media: (dayJson.media || []).map(m => ({
        type: m.type, name: m.name,
        driveFileId: m.driveFileId,
        caption: m.caption || ''
      }))
    };
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
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    _imgCache[cacheKey] = url;
    return url;
  } catch(e) {
    console.warn('Error cargando imagen autenticada:', e);
    return '';
  }
}

// Helper para img elements: intenta thumbnail, si falla usa API auth
function setAuthImg(imgEl, fileId, size = 'w800') {
  if (!fileId || !imgEl) return;
  const thumbUrl = `https://drive.google.com/thumbnail?id=${fileId}&sz=${size}`;
  imgEl.src = thumbUrl;
  imgEl.onerror = async () => {
    imgEl.onerror = null; // evitar loop
    const authUrl = await fetchAuthImgUrl(fileId);
    if (authUrl) imgEl.src = authUrl;
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
