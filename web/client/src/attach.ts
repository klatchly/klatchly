// The attachment a media action is about (save, share, copy, open), with the URL and name to use.
import { attachmentUrl } from './endpoints';
import { extOf, normName, previewOf } from './files';
import { downloadName, mediaKey, mediaKind } from './gallery';
import type { MediaKindForMenu } from './menuactions';
import type { SaveTarget } from './save';
import type { Attachment, Message } from './types';

export interface MediaTarget extends SaveTarget {
  kind: MediaKindForMenu;
  /** Index in the message's attachments, and the lightbox key of pictures. */
  index: number;
  key: string;
  /** Opens somewhere in the app: the lightbox (pictures, GIFs, videos) or the file viewer (every file). */
  openable: boolean;
  preview?: 'pdf' | 'html';
  att: Attachment;
}

export function attachmentKind(a: Attachment): MediaKindForMenu | undefined {
  if (a.isSticker) return undefined;
  const k = mediaKind(a);
  if (k === 'img') return 'image';
  if (k === 'gif') return 'gif';
  if (k === 'video') return 'video';
  if (a.type === 'img') return undefined; // Lottie stickers and the like
  if (a.type === 'video') return 'video';
  if (a.type === 'audio') return 'audio';
  return 'file';
}

/** File name to save an attachment under: its own (normalised), else one built from its type. */
export function saveName(a: Attachment, kind: MediaKindForMenu): string {
  if (kind === 'image' || kind === 'gif') return downloadName({ fileName: normName(a.fileName) || undefined, mime: a.mimeType, kind: kind === 'gif' ? 'gif' : 'img' });
  const n = normName(a.fileName).replace(/[:*?"<>|]/g, '_');
  if (n) return n;
  const ext = extOf(undefined, a.mimeType);
  const base = kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'file';
  return ext ? `${base}.${ext}` : base;
}

/** The pressed attachment (index), else the message's first one that media actions apply to. */
export function mediaTarget(m: Message, index?: number): MediaTarget | undefined {
  if (m.isDeleted || !m.attachments?.length) return undefined;
  const order = index !== undefined && m.attachments[index] ? [index] : m.attachments.map((_, i) => i);
  for (const i of order) {
    const a = m.attachments[i]!;
    const kind = attachmentKind(a);
    const src = kind && attachmentUrl(a);
    if (!kind || !src) continue;
    return {
      kind,
      index: i,
      key: mediaKey(m.id, i),
      src,
      name: saveName(a, kind),
      mime: a.mimeType,
      size: a.fileSize,
      openable: kind === 'image' || kind === 'gif' || kind === 'video' || kind === 'file',
      preview: kind === 'file' ? previewOf(a.fileName, a.mimeType) : undefined,
      att: a,
    };
  }
  return undefined;
}
