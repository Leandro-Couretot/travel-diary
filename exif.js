// ─── EXIF DATE READER ────────────────────────────────────
// Reads DateTimeOriginal from JPEG EXIF without external libs
// Also falls back to video metadata via lastModified

/**
 * Returns a date string "YYYY-MM-DD" from a File's EXIF data,
 * or null if not found.
 */
async function getFileDateStr(file) {
  try {
    if (file.type.startsWith('image/jpeg') || file.type.startsWith('image/jpg')) {
      const date = await readJpegExifDate(file);
      if (date) return date;
    }
    if (file.type.startsWith('image/heic') || file.type.startsWith('image/heif')) {
      const date = await readJpegExifDate(file); // HEIC also uses EXIF
      if (date) return date;
    }
    if (file.type.startsWith('video/') || file.type.startsWith('image/')) {
      // Fallback: use file lastModified (not ideal but better than nothing)
      if (file.lastModified) {
        return new Date(file.lastModified).toISOString().slice(0, 10);
      }
    }
  } catch(e) {
    console.warn('EXIF read error:', e);
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
