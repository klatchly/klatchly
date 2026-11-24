// File attachments: kind (icon), display name, extension, what can be previewed in the app. Pure functions
// (unit-tested in test/files.test.ts), no imports.

export type FileKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'archive' | 'audio' | 'video' | 'image' | 'text' | 'generic';

const BY_EXT: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', pages: 'doc', md: 'text', txt: 'text', log: 'text',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet', numbers: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive',
  mp3: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio', flac: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', heif: 'image', avif: 'image', bmp: 'image', tif: 'image', tiff: 'image',
};

const EXT_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/zip': 'zip',
  'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar',
  'application/x-7z-compressed': '7z',
  'application/gzip': 'gz',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'image/jpeg': 'jpg',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
};

/**
 * A name to show and to save under: NFC (some networks send decomposed Vietnamese names, whose combining
 * marks then render as boxes), without control or bidi-override characters (a "gpj.exe" spoof) or path parts.
 */
export function normName(name: string | undefined): string {
  if (!name) return '';
  return name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower-case extension (no dot) from the name, else from the MIME type; '' when unknown. */
export function extOf(name: string | undefined, mime?: string): string {
  const n = normName(name);
  const dot = n.lastIndexOf('.');
  if (dot > 0 && dot < n.length - 1) {
    const e = n.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(e)) return e;
  }
  const t = mime?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (EXT_BY_MIME[t]) return EXT_BY_MIME[t]!;
  const sub = /^(image|video|audio)\/([a-z0-9]{1,8})$/.exec(t)?.[2];
  return sub ?? '';
}

export function fileKind(name: string | undefined, mime?: string): FileKind {
  const k = BY_EXT[extOf(name, mime)];
  if (k) return k;
  const t = mime?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (t === 'application/pdf') return 'pdf';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (t.startsWith('text/')) return 'text';
  return 'generic';
}

/** What the in-app viewer can show itself (the other files get a card with Save / Share). */
export function previewOf(name: string | undefined, mime?: string): 'pdf' | 'html' | undefined {
  if (fileKind(name, mime) === 'pdf') return 'pdf';
  const ext = extOf(name, mime);
  return ext === 'html' || ext === 'htm' || mime?.split(';')[0]?.trim().toLowerCase() === 'text/html' ? 'html' : undefined;
}

/**
 * Long names cut in the middle so the start and the extension both stay visible:
 * "Contrat de location 2026 – version finale signée.pdf" → "Contrat de locat…signée.pdf". Counted in
 * code points (never splits an emoji or an accented letter's surrogate pair).
 */
export function middleTruncate(name: string, max = 30): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 9 ? [...name.slice(dot)] : [];
  const stem = chars.slice(0, chars.length - ext.length);
  const room = Math.max(2, max - ext.length - 1);
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${stem.slice(0, head).join('').trimEnd()}…${stem.slice(stem.length - tail).join('').trimStart()}${ext.join('')}`;
}

/** "PDF", "DOCX"… for the size line; '' when unknown. */
export const extLabel = (name: string | undefined, mime?: string) => extOf(name, mime).toUpperCase();

/**
 * A name in two parts for a middle ellipsis that fits any width (CSS shrinks the head with "…", the tail
 * never shrinks): the tail is the extension and the few characters before it.
 */
export function splitName(name: string, tailChars = 6): { head: string; tail: string } {
  const chars = [...name];
  const dot = name.lastIndexOf('.');
  const extLen = dot > 0 && name.length - dot <= 9 ? [...name.slice(dot)].length : 0;
  const cut = Math.max(0, chars.length - extLen - tailChars);
  if (cut < 4) return { head: '', tail: name };
  return { head: chars.slice(0, cut).join(''), tail: chars.slice(cut).join('') };
}
