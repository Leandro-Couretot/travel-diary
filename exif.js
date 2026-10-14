// ─── EXIF DATE READER ────────────────────────────────────
// Reads DateTimeOriginal from JPEG EXIF without external libs
// Also falls back to video metadata via lastModified

/**
 * Returns a date string "YYYY-MM-DD" from a File's EXIF data,
 * or null if not found.
 */
async function getFileDateStr(file) {
  try {
    const name = (file.name || '').toLowerCase();
    const type = file.type || '';
    const isVideo = type.startsWith('video/') || /\.(mp4|mov|m4v)$/.test(name);
    const isHeic = type.startsWith('image/heic') || type.startsWith('image/heif') || /\.(heic|heif)$/.test(name);
    if (type.startsWith('image/jpeg') || type.startsWith('image/jpg')) {
      const date = await readJpegExifDate(file);
      if (date) return date;
    }
    if (isHeic) {
      // v2.114: HEIC (el formato de foto de iPhone) NO es un JPEG: su EXIF
      // vive dentro de un contenedor ISO-BMFF, así que readJpegExifDate()
      // siempre devolvía null y la foto caía a lastModified (la fecha en que
      // se bajó el archivo, no la de la foto).
      const date = await readHeicExifDate(file);
      if (date) return date;
    }
    if (isVideo) {
      // v2.114: la fecha real de grabación de un MP4/MOV vive en el átomo
      // `mvhd` (creation_time) dentro del propio archivo. lastModified de un
      // video bajado de Drive suele ser el momento de la descarga ("hoy").
      const date = await readMp4CreationDate((start, len) => readSlice(file, start, len), file.size);
      if (date) return date;
    }
    if (type.startsWith('video/') || type.startsWith('image/') || isVideo || isHeic) {
      // Fallback: use file lastModified (not ideal but better than nothing)
      if (file.lastModified) {
        // Bug real (v2.13, ver CLAUDE.md): toISOString() da la fecha en
        // UTC, no en el huso del usuario — un archivo modificado de noche
        // en un huso negativo (Argentina, UTC-3) podía quedar fechado al
        // día SIGUIENTE. Se arma la fecha con los componentes locales del
        // propio Date, nunca con su representación UTC.
        return _localDateFromMs(file.lastModified);
      }
    }
  } catch(e) {
    console.warn('EXIF read error:', e);
  }
  return null;
}

function _localDateFromMs(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * v2.114: fecha de grabación de un video MP4/MOV/M4V leyendo el átomo `mvhd`
 * (creation_time: segundos desde 1904-01-01 UTC) del contenedor ISO-BMFF.
 * `readRange(start, len)` devuelve un ArrayBuffer (de un File local o de un
 * pedido con Range a Drive), así que sirve para los dos caminos de importación.
 * Recorre solo las cabeceras de los átomos de primer nivel (saltando `mdat`,
 * que es lo pesado): son unas pocas lecturas de 16 bytes más una de ~64 bytes
 * dentro de `moov`. La fecha se devuelve en el huso local del navegador.
 * Devuelve null si no es un MP4/MOV válido o si la fecha es 0/absurda.
 */
async function readMp4CreationDate(readRange, totalSize) {
  const EPOCH_1904_TO_1970 = 2082844800; // segundos
  let offset = 0;
  for (let i = 0; i < 40; i++) {
    if (totalSize && offset + 8 > totalSize) return null;
    const head = await readRange(offset, 16);
    if (!head || head.byteLength < 8) return null;
    const v = new DataView(head);
    let size = v.getUint32(0);
    const type = String.fromCharCode(v.getUint8(4), v.getUint8(5), v.getUint8(6), v.getUint8(7));
    let headerLen = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = v.getUint32(8) * 4294967296 + v.getUint32(12);
      headerLen = 16;
    } else if (size === 0) {
      size = totalSize ? totalSize - offset : 0; // "hasta el final del archivo"
    }
    if (type === 'moov') {
      // mvhd es el primer hijo de moov: header(8) + version/flags(4) + fechas.
      const body = await readRange(offset + headerLen, 40);
      if (!body || body.byteLength < 20) return null;
      const b = new DataView(body);
      const childType = String.fromCharCode(b.getUint8(4), b.getUint8(5), b.getUint8(6), b.getUint8(7));
      if (childType !== 'mvhd') return null;
      const version = b.getUint8(8);
      let secs;
      if (version === 1) {
        if (body.byteLength < 20 + 4) return null;
        secs = b.getUint32(12) * 4294967296 + b.getUint32(16);
      } else {
        secs = b.getUint32(12);
      }
      if (!secs) return null;
      const ms = (secs - EPOCH_1904_TO_1970) * 1000;
      const y = new Date(ms).getUTCFullYear();
      if (!(ms > 0) || y < 2000 || ms > Date.now() + 86400000) return null;
      return _localDateFromMs(ms);
    }
    if (!size || size < headerLen) return null;
    offset += size;
  }
  return null;
}

/**
 * v2.114: EXIF de una foto HEIC/HEIF (iPhone). El EXIF va dentro de un item del
 * contenedor ISO-BMFF; en la práctica queda al principio del archivo, así que
 * alcanza con buscar la firma "Exif\0\0" + cabecera TIFF ("MM\0*" o "II*\0")
 * en los primeros 512 KB y reusar el mismo parser que ya usamos para JPEG.
 */
async function readHeicExifDate(file) {
  const buf = await readSlice(file, 0, 524288);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i + 12 < bytes.length; i++) {
    if (bytes[i] === 0x45 && bytes[i + 1] === 0x78 && bytes[i + 2] === 0x69 && bytes[i + 3] === 0x66 &&
        bytes[i + 4] === 0 && bytes[i + 5] === 0) {
      const a = bytes[i + 6], b = bytes[i + 7], c = bytes[i + 8], d = bytes[i + 9];
      const tiffOk = (a === 0x4D && b === 0x4D && c === 0 && d === 0x2A) || (a === 0x49 && b === 0x49 && c === 0x2A && d === 0);
      if (!tiffOk) continue;
      const view = new DataView(buf, i, Math.min(65536, bytes.length - i));
      try { const date = parseExifSegment(view); if (date) return date; } catch {}
    }
  }
  return null;
}

/**
 * Reads the first ~64KB of a JPEG to find EXIF DateTimeOriginal.
 * EXIF format: "YYYY:MM:DD HH:MM:SS"
 */
async function readJpegExifDate(file) {
  const buf = await readSlice(file, 0, 65536);
  const view = new DataView(buf);

  // Must start with JPEG SOI marker FF D8
  if (view.getUint16(0) !== 0xFFD8) return null;

  let offset = 2;
  while (offset < view.byteLength - 4) {
    const marker = view.getUint16(offset);
    offset += 2;
    if (marker === 0xFFE1) {
      // APP1 — likely EXIF
      const segLen = view.getUint16(offset);
      const segData = new DataView(buf, offset + 2, segLen - 2);
      const date = parseExifSegment(segData);
      if (date) return date;
      offset += segLen;
    } else if ((marker & 0xFF00) === 0xFF00) {
      // Other segment — skip
      const segLen = view.getUint16(offset);
      offset += segLen;
    } else {
      break;
    }
  }
  return null;
}

function parseExifSegment(view) {
  // Check for "Exif\0\0" header
  if (view.byteLength < 6) return null;
  const header = String.fromCharCode(
    view.getUint8(0), view.getUint8(1),
    view.getUint8(2), view.getUint8(3)
  );
  if (header !== 'Exif') return null;

  // Byte order at offset 6
  const tiffOffset = 6;
  const byteOrder = view.getUint16(tiffOffset);
  const le = byteOrder === 0x4949; // little-endian (II) vs big-endian (MM)

  const getU16 = (o) => view.getUint16(tiffOffset + o, le);
  const getU32 = (o) => view.getUint32(tiffOffset + o, le);
  const getString = (o, len) => {
    let s = '';
    for (let i = 0; i < len && tiffOffset + o + i < view.byteLength; i++) {
      const c = view.getUint8(tiffOffset + o + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  // TIFF magic
  if (getU16(2) !== 0x002A) return null;
  const ifdOffset = getU32(4);

  // Read IFD0
  const date = readIFDForDate(getU16, getU32, getString, ifdOffset, le, view, tiffOffset);
  if (date) return date;

  // Try SubIFD (ExifIFD) — tag 0x8769
  const subIfdOffset = findTag(getU16, getU32, ifdOffset, 0x8769);
  if (subIfdOffset) {
    return readIFDForDate(getU16, getU32, getString, subIfdOffset, le, view, tiffOffset);
  }
  return null;
}

function readIFDForDate(getU16, getU32, getString, ifdOffset, le, view, tiffOffset) {
  if (ifdOffset + 2 > view.byteLength) return null;
  const count = getU16(ifdOffset);
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > view.byteLength) break;
    const tag = getU16(entryOffset);
    // DateTimeOriginal = 0x9003, DateTimeDigitized = 0x9004, DateTime = 0x0132
    if (tag === 0x9003 || tag === 0x9004 || tag === 0x0132) {
      const type = getU16(entryOffset + 2);
      const count = getU32(entryOffset + 4);
      const valueOffset = getU32(entryOffset + 8);
      // ASCII string
      const str = getString(valueOffset, count);
      const date = parseExifDateStr(str);
      if (date) return date;
    }
  }
  return null;
}

function findTag(getU16, getU32, ifdOffset, targetTag) {
  try {
    const count = getU16(ifdOffset);
    for (let i = 0; i < count; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = getU16(entryOffset);
      if (tag === targetTag) return getU32(entryOffset + 8);
    }
  } catch {}
  return null;
}

function parseExifDateStr(str) {
  // "YYYY:MM:DD HH:MM:SS"
  if (!str || str.length < 10) return null;
  const match = str.match(/^(\d{4}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, y, m, d] = match;
  if (y === '0000') return null;
  return `${y}-${m}-${d}`;
}

function readSlice(file, start, length) {
  return new Promise((resolve, reject) => {
    const slice = file.slice(start, start + length);
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(slice);
  });
}

/**
 * Groups an array of Files by date.
 * Returns: { dated: { "YYYY-MM-DD": [File] }, undated: [File] }
 */
async function groupFilesByDate(files) {
  const dated = {};
  const undated = [];

  for (const file of files) {
    const date = await getFileDateStr(file);
    if (date) {
      if (!dated[date]) dated[date] = [];
      dated[date].push(file);
    } else {
      undated.push(file);
    }
  }

  return { dated, undated };
}
