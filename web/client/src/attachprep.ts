import { imageConversion, type AttachmentCaps, type ConvertTarget } from '../../server/attachplan.js';

// A file as the composer gets it (picked, dropped, pasted) made ready for the chat's network before its plan
// (caps.ts attachmentPlan) and its upload. A pasted picture may come with no type or a generic one and no name
// (some clipboards, some apps): its type is read from its first bytes and it gets a name. A picture the network
// refuses as such (caps: attachmentPlanFor) but would take as a PNG or JPEG, or one too large for it, is re-encoded
// (attachplan.ts imageConversion; redraw.ts: on a canvas) rather than refused. GIFs are not: an animation would
// silently become a still. The pure parts are unit-tested (test/attachprep.test.ts); the canvas in the browser by
// the end-to-end tests of a connector whose network takes pictures only as PNG or JPEG.

const HEAD = 16;

/** The picture type of these first bytes, or undefined. */
export function sniffImage(b: Uint8Array): string | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'image/png';
  if (b.length >= 4 && ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ['ftypavif', 'ftypavis'].includes(ascii(4, 12))) return 'image/avif';
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp';
  return undefined;
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp' };

/** Whether the browser said nothing useful about the file's type. */
export const untyped = (type: string) => !type || type === 'application/octet-stream';

/**
 * The name to send a file under: its own, its extension changed when its type did (a conversion), or "image.png"
 * style when it has none (a pasted picture).
 */
export function nameFor(name: string, type: string, converted: boolean): string {
  const ext = EXT[type];
  if (!name.trim()) return ext ? `image.${ext}` : 'file';
  if (!converted || !ext) return name;
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

/**
 * Re-encodes a picture as `type`, within `maxBytes` when given (a JPEG: lower quality, then smaller, until it
 * fits); null when it cannot (redraw.ts: on a canvas).
 */
export type Redraw = (file: Blob, type: ConvertTarget, maxBytes?: number) => Promise<Blob | null>;

/**
 * The file to plan and upload for a chat with these capabilities (the same file when nothing needs doing). Its
 * plan is made on what comes out: a re-encoded picture still too large is refused for its size, with the limit.
 */
export async function prepareFile(file: File, caps: AttachmentCaps | null | undefined, redraw: Redraw): Promise<File> {
  let type = file.type.toLowerCase();
  if (untyped(type)) {
    const head = new Uint8Array(await file.slice(0, HEAD).arrayBuffer().catch(() => new ArrayBuffer(0)));
    type = sniffImage(head) ?? type;
  }
  const name = nameFor(file.name, type, false);
  let out = type === file.type && name === file.name ? file : new File([file], name, { type, lastModified: file.lastModified });
  // Twice at most: a BMP becomes a PNG, which may then be too large and become a smaller JPEG.
  for (let i = 0; i < 2; i++) {
    const conv = imageConversion(caps, out.type, out.size);
    const redrawn = conv ? await redraw(out, conv.type, conv.maxBytes).catch(() => null) : null;
    if (!conv || !redrawn) break;
    out = new File([redrawn], nameFor(out.name, conv.type, true), { type: conv.type, lastModified: file.lastModified });
  }
  return out;
}
