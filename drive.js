// ─── DRIVE CONFIG ────────────────────────────────────────
const DRIVE_CLIENT_ID = '29099211489-421jp27om456sbegj4qhcohvimkfbd5m.apps.googleusercontent.com';
const DRIVE_SCOPE     = 'https://www.googleapis.com/auth/drive.file';
const ROOT_FOLDER     = 'travel-diary';

// ─── STATE ───────────────────────────────────────────────
let driveToken    = null;
let rootFolderId  = null;
let tokenClient   = null;
let _onConnected  = null; // callback set by each page

// ─── INIT ────────────────────────────────────────────────
function initDrive(onConnectedCallback) {
  _onConnected = onConnectedCallback;
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
        await _bootstrapDrive();
      }
    });
    const saved = localStorage.getItem('drive_token');
    if (saved) { driveToken = saved; _bootstrapDrive(); }
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
async function driveReq(method, url, body) {
  const headers = { 'Authorization': `Bearer ${driveToken}` };
  const opts = { method, headers };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    driveToken = null; rootFolderId = null;
    localStorage.removeItem('drive_token');
    throw new Error('Token expirado — reconectá Drive');
  }
  return res;
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

async function listDayFolders(albumFolderId) {
  const folders = await listFolders(albumFolderId);
  // Filter to date-shaped folders only (YYYY-MM-DD)
  return folders.filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f.name)).map(f => f.name).sort();
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
  return await getOrCreateFolder(albumId, rootFolderId);
}

// ─── DAY OPERATIONS ──────────────────────────────────────

async function saveDayToDrive(albumFolderId, dateStr, day) {
  const dayFolderId = await getOrCreateFolder(dateStr, albumFolderId);
  for (const item of day.media) {
    if (!item.driveFileId && item.data) {
      const blob = base64ToBlob(item.data);
      item.driveFileId = await uploadFile(blob, item.name, dayFolderId);
      delete item.data; // free memory after upload
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
  return day;
}

async function loadDayFromDrive(albumFolderId, dateStr) {
  try {
    const q = `name='${dateStr}' and mimeType='application/vnd.google-apps.folder' and '${albumFolderId}' in parents and trashed=false`;
    const res = await driveReq('GET', `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)`);
    const data = await res.json();
    if (!data.files || !data.files.length) return null;
    const dayFolderId = data.files[0].id;
    const jsonId = await findFileInFolder('day.json', dayFolderId);
    if (!jsonId) return null;
    const dayJson = await readJsonFile(jsonId);
    return {
      title: dayJson.title || '',
      notes: dayJson.notes || '',
      media: (dayJson.media || []).map(m => ({
        type: m.type, name: m.name,
        driveFileId: m.driveFileId,
        caption: m.caption || ''
      }))
    };
  } catch(e) {
    console.warn('Error cargando día desde Drive:', e);
    return null;
  }
}

// ─── MIGRATION ───────────────────────────────────────────
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
