// How a file can go to a chat, from the capabilities its bridge reports. Pure, shared by the client (composer,
// forward picker: client/src/caps.ts) and the server (forwarding, server/forward.ts). Native Beeper (Matrix)
// chats report no capabilities: an empty object means "no restrictions known".

export type SupportLevel = -2 | -1 | 0 | 1 | 2;
export interface AttachmentCaps {
  attachments?: Record<string, { mimeTypes?: Record<string, SupportLevel>; caption?: SupportLevel; maxSize?: number }>;
}

export interface AttachmentPlan {
  ok: boolean;
  /** Send as a generic file because the network rejects this media type. */
  asFile?: boolean;
  caption: boolean;
  maxSize?: number;
}

const level = (v: SupportLevel | undefined) => (v ?? 0) >= 1;

function mimeAccepted(types: Record<string, SupportLevel> | undefined, mime: string): boolean {
  if (!types) return false;
  const major = mime.split('/')[0];
  return [mime, `${major}/*`, '*/*'].some((k) => level(types[k]));
}

function slotFor(mime: string): string {
  if (mime === 'image/gif') return 'fi.mau.gif';
  if (mime.startsWith('image/')) return 'm.image';
  if (mime.startsWith('video/')) return 'm.video';
  if (mime.startsWith('audio/')) return 'm.audio';
  return 'm.file';
}

const known = (c: AttachmentCaps | null | undefined) => (c && Object.keys(c).length > 0 ? c : undefined);

/** False when the network accepts no files at all (an empty attachment list). */
export function acceptsFiles(c: AttachmentCaps | null | undefined): boolean {
  const atts = known(c)?.attachments;
  return !atts || Object.keys(atts).length > 0;
}

export function attachmentPlanFor(c: AttachmentCaps | null | undefined, mime: string, size: number): AttachmentPlan {
  const atts = known(c)?.attachments;
  if (!atts) return { ok: true, caption: true };
  const m = mime || 'application/octet-stream';
  const tryKey = (key: string): AttachmentPlan | null => {
    const a = atts[key];
    if (!a || !mimeAccepted(a.mimeTypes, m)) return null;
    if (a.maxSize && size > a.maxSize) return { ok: false, caption: false, maxSize: a.maxSize };
    return { ok: true, caption: level(a.caption), asFile: key === 'm.file' && slotFor(m) !== 'm.file' };
  };
  const primary = slotFor(m);
  return (
    tryKey(primary) ??
    (primary === 'fi.mau.gif' ? tryKey('m.image') : null) ??
    (primary !== 'm.file' ? tryKey('m.file') : null) ?? { ok: false, caption: false }
  );
}

// Picture types a browser decodes and re-encodes on a canvas: what a picture the network refuses (or finds too
// large) may become, lossless first. Not SVG (a document, not pixels), not GIF (an animation would silently become
// a still: the plan refuses it instead), nothing the browser cannot decode (HEIC: left as it is).
const CONVERTIBLE = /^image\/(png|jpeg|webp|avif|bmp|x-ms-bmp|tiff|x-icon|vnd\.microsoft\.icon)$/;
const TARGETS = ['image/png', 'image/jpeg'] as const;
export type ConvertTarget = (typeof TARGETS)[number];

/** A re-encoding to do before the plan: to `type`, in at most `maxBytes` when the network has a limit. */
export interface Conversion {
  type: ConvertTarget;
  maxBytes?: number;
}

/** Whether `t` goes as a picture (not as a file) at some size, and the network's size limit for it. */
function asPicture(c: AttachmentCaps | null | undefined, t: string): { ok: boolean; maxBytes?: number } {
  const p = attachmentPlanFor(c, t, 0);
  if (!p.ok || p.asFile) return { ok: false };
  const max = attachmentPlanFor(c, t, Number.MAX_SAFE_INTEGER).maxSize;
  return max ? { ok: true, maxBytes: max } : { ok: true };
}

/**
 * How to re-encode a picture before it is sent, or undefined: not a convertible picture, or taken as it is. A
 * picture whose type the network refuses (a BMP, an AVIF) or would only take as a generic file becomes a PNG (or a
 * JPEG) when the network takes that as a picture; one too large for the network becomes a JPEG within its limit
 * (redrawn smaller when it must be).
 */
export function imageConversion(c: AttachmentCaps | null | undefined, mime: string, size: number): Conversion | undefined {
  if (!CONVERTIBLE.test(mime)) return undefined;
  const plan = attachmentPlanFor(c, mime, size);
  if (plan.ok && !plan.asFile) return undefined;
  if (plan.maxSize) {
    const jpeg = asPicture(c, 'image/jpeg');
    return jpeg.ok ? { type: 'image/jpeg', maxBytes: jpeg.maxBytes ?? plan.maxSize } : undefined;
  }
  for (const t of TARGETS) {
    if (t === mime) continue;
    const p = asPicture(c, t);
    if (p.ok) return p.maxBytes ? { type: t, maxBytes: p.maxBytes } : { type: t };
  }
  return undefined;
}
