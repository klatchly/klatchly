// Photo albums: consecutive picture / video messages of one sender drawn as one bubble with a mosaic, and the
// mosaic's layout. Pure functions (unit-tested in test/albums.test.ts): structural copies of the types.ts shapes,
// no imports.
//
// Grouping is decided pair by pair: whether message i+1 joins message i depends on those two messages only
// (sender, time, day, kind, caption, reply, divider). So loading older pages or receiving new messages can only
// change the boundary where the new messages touch the list, never re-split albums further away (no jump).

export interface AlbumAttachment {
  type: string;
  srcURL?: string;
  mimeType?: string;
  isGif?: boolean;
  isSticker?: boolean;
  size?: { width?: number; height?: number };
}
export interface AlbumMessage {
  id: string;
  senderID: string;
  isSender?: boolean;
  timestamp: string;
  type?: string;
  text?: string;
  isDeleted?: boolean;
  linkedMessageID?: string;
  attachments?: AlbumAttachment[];
  sendStatus?: { status?: string };
}

/** At most this long between two messages of an album (WhatsApp / Telegram send albums one message per item). */
export const ALBUM_GAP_MS = 60_000;

/** What a mosaic tile can show: photos (GIF photos too) and real videos. Not stickers, Lottie, network GIFs. */
export function tileKind(a: AlbumAttachment): 'img' | 'video' | undefined {
  if (!a.srcURL || a.isSticker) return undefined;
  const mime = (a.mimeType ?? '').toLowerCase();
  if (a.type === 'img' && !mime.includes('lottie')) return 'img';
  if (a.type === 'video' && !a.isGif) return 'video';
  return undefined;
}

/**
 * A message that can be (part of) an album: only tiles as attachments, shown normally (not deleted, not a
 * notice, not still sending or failed: those keep their own status line), a real ID.
 */
export function albumable(m: AlbumMessage): boolean {
  if (m.isDeleted || m.type === 'NOTICE' || m.id.startsWith('~')) return false;
  const st = m.sendStatus?.status;
  if (st === 'PENDING' || st?.startsWith('FAIL')) return false;
  return !!m.attachments?.length && m.attachments.every((a) => !!tileKind(a));
}

const sender = (m: AlbumMessage) => (m.isSender ? '\0self' : m.senderID);
const localDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * Message `b` joins the album of the message before it, `a`: both albumable, same sender, same day, at most
 * 60 s apart (in order), and nothing on `b` that only the first item can carry: a caption (shown under the
 * mosaic, so a captioned item starts an album: WhatsApp and Telegram put an album's caption on its first
 * item) or a reply quote (drawn above the mosaic). The unread divider (`breakBefore`) also starts one.
 * Reactions do not split an album: they show on their tile.
 */
export function joins(a: AlbumMessage, b: AlbumMessage, breakBefore?: string, day = localDay): boolean {
  if (!albumable(a) || !albumable(b)) return false;
  if (sender(a) !== sender(b) || b.id === breakBefore) return false;
  if (b.text?.trim() || b.linkedMessageID) return false;
  const dt = Date.parse(b.timestamp) - Date.parse(a.timestamp);
  if (!(dt >= 0 && dt <= ALBUM_GAP_MS)) return false;
  return day(a.timestamp) === day(b.timestamp);
}

/**
 * Runs of the list (oldest first) to draw as one bubble each: a run of 2+ joined messages, or a lone message
 * with 2+ tiles (several attachments in one message) is an album; every other message is a run of one.
 */
export function groupAlbums<M extends AlbumMessage>(msgs: readonly M[], breakBefore?: string, day = localDay): M[][] {
  const out: M[][] = [];
  for (const m of msgs) {
    const run = out[out.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && joins(last, m, breakBefore, day)) run.push(m);
    else out.push([m]);
  }
  return out;
}

/** The run is drawn as an album (else as the ordinary bubble of its only message). */
export function isAlbum(run: readonly AlbumMessage[]): boolean {
  if (run.length > 1) return true;
  const m = run[0];
  return !!m && albumable(m) && (m.attachments?.length ?? 0) > 1;
}

// --- Mosaic --------------------------------------------------------------------------------------------------
// The album is a CSS grid of fixed proportions (aspect-ratio on the box, fr tracks, 2 px gaps), as wide as a
// single picture bubble (280 CSS px, less on a narrow screen): its height never depends on the pictures
// loading, so the list does not move. 4 tiles at most; the 4th shows "+N" for the rest.

export const MOSAIC_WIDTH = 280;
export const MOSAIC_GAP = 2;
const MAX_TILES = 4;

export interface MosaicTile {
  /** grid-column / grid-row values */
  col: string;
  row: string;
  /** Size in CSS px at the full width (thumbnail choice). */
  w: number;
  h: number;
}
export interface Mosaic {
  cols: string;
  rows: string;
  /** width / height of the whole box */
  ratio: number;
  tiles: MosaicTile[];
  /** Items not shown: "+N" on the last tile. */
  more: number;
}

const landscape = (r: number | undefined) => !!r && r > 1.2;

/**
 * Layout for n items, by the items' aspect ratios (width / height, undefined when unknown):
 * 2 → side by side (stacked when both are landscape), 3 → one large and two small (large on top when it is
 * landscape, on the left otherwise), 4+ → 2 × 2.
 */
export function mosaic(n: number, ratios: readonly (number | undefined)[] = [], width = MOSAIC_WIDTH, gap = MOSAIC_GAP): Mosaic {
  const half = (width - gap) / 2;
  const px = (v: number) => Math.round(v * 100) / 100;
  if (n <= 1) {
    return { cols: '1fr', rows: '1fr', ratio: ratios[0] && ratios[0] > 0 ? ratios[0] : 1, tiles: [{ col: '1', row: '1', w: width, h: width }], more: 0 };
  }
  if (n === 2) {
    if (landscape(ratios[0]) && landscape(ratios[1])) {
      const h = Math.round((width * 9) / 16);
      return { cols: '1fr', rows: '1fr 1fr', ratio: width / (2 * h + gap), tiles: [{ col: '1', row: '1', w: width, h }, { col: '1', row: '2', w: width, h }], more: 0 };
    }
    const h = 200;
    return { cols: '1fr 1fr', rows: '1fr', ratio: width / h, tiles: [{ col: '1', row: '1', w: px(half), h }, { col: '2', row: '1', w: px(half), h }], more: 0 };
  }
  if (n === 3) {
    if (landscape(ratios[0])) {
      const top = 160;
      const bottom = Math.round(half);
      return {
        cols: '1fr 1fr',
        rows: `${top}fr ${bottom}fr`,
        ratio: width / (top + gap + bottom),
        tiles: [
          { col: '1 / 3', row: '1', w: width, h: top },
          { col: '1', row: '2', w: px(half), h: bottom },
          { col: '2', row: '2', w: px(half), h: bottom },
        ],
        more: 0,
      };
    }
    const h = 240;
    const left = Math.round((width - gap) * 0.6);
    const right = width - gap - left;
    const small = (h - gap) / 2;
    return {
      cols: `${left}fr ${right}fr`,
      rows: '1fr 1fr',
      ratio: width / h,
      tiles: [
        { col: '1', row: '1 / 3', w: left, h },
        { col: '2', row: '1', w: right, h: px(small) },
        { col: '2', row: '2', w: right, h: px(small) },
      ],
      more: 0,
    };
  }
  const tiles: MosaicTile[] = [];
  for (let i = 0; i < MAX_TILES; i++) tiles.push({ col: String((i % 2) + 1), row: String(Math.floor(i / 2) + 1), w: px(half), h: px(half) });
  return { cols: '1fr 1fr', rows: '1fr 1fr', ratio: 1, tiles, more: n - MAX_TILES };
}

/**
 * CSS width a picture is drawn at to cover a tile (object-fit: cover): the thumbnail is chosen for it. A tall
 * picture in a wide tile is drawn at the tile's width; a wide one in a tall tile, wider than the tile.
 */
export function coverWidth(tile: { w: number; h: number }, ratio: number | undefined): number {
  if (!ratio || ratio <= 0) return Math.max(tile.w, tile.h);
  return Math.ceil(Math.max(tile.w, tile.h * ratio));
}

/** "1:05", "12:00", "1:02:03" for a video's length in seconds. */
export function durationLabel(sec: number | undefined): string | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return undefined;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
