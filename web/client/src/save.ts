// Saving, sharing and copying media and files.
//
// iOS (the Home Screen app included) cannot download: a download link opens Quick Look or replaces the app's
// page. There the share sheet is the way ("Save Image" to Photos, "Save to Files", AirDrop...), and it must
// be opened synchronously inside the tap, with a File already in memory. So files are fetched ahead (when the
// menu or the viewer opens), and a tap on a file that is not ready yet shows its progress, then a "Tap to save"
// button: the second tap opens the sheet. Only `files` is passed to share(): adding text or a URL removes
// "Save Image". Elsewhere (desktop) a same-origin download link, under the file's real name.
import { useSyncExternalStore } from 'react';
import { isIOS } from './push';

export interface SaveTarget {
  src: string;
  /** File name to save under (already normalised, see files.ts normName / gallery.ts downloadName). */
  name: string;
  mime?: string;
  /** Expected size in bytes, when the message says so. */
  size?: number;
}

/** Share sheet instead of downloads: iOS with the Web Share API for files. */
export const shareMode = (): boolean => isIOS() && typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

export const MAX_FETCH = 150 * 1024 * 1024;
/** Bigger files are fetched on the tap only, not ahead when a menu opens. */
export const PREFETCH_MAX = 25 * 1024 * 1024;
const KEEP_BYTES = 200 * 1024 * 1024;

export type FileEntry =
  | { status: 'loading'; loaded: number; total: number }
  | { status: 'ready'; file: File; loaded: number; total: number }
  | { status: 'error'; reason: 'too-large' | 'failed'; loaded: number; total: number };

const entries = new Map<string, FileEntry>();
const pending = new Map<string, Promise<File | undefined>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Ready files kept in memory, oldest dropped first beyond KEEP_BYTES. */
function trim() {
  let bytes = 0;
  for (const [src, e] of [...entries].reverse()) {
    if (e.status !== 'ready') continue;
    bytes += e.file.size;
    if (bytes > KEEP_BYTES) entries.delete(src);
  }
}

function set(src: string, e: FileEntry) {
  entries.delete(src);
  entries.set(src, e);
  emit();
}

/** The file as a File (from the browser cache when it is on screen already), with progress; one fetch per src. */
export function fetchFile(t: SaveTarget): Promise<File | undefined> {
  const e = entries.get(t.src);
  if (e?.status === 'ready') return Promise.resolve(e.file);
  const p = pending.get(t.src);
  if (p) return p;
  if (t.size && t.size > MAX_FETCH) {
    set(t.src, { status: 'error', reason: 'too-large', loaded: 0, total: t.size });
    return Promise.resolve(undefined);
  }
  set(t.src, { status: 'loading', loaded: 0, total: t.size ?? 0 });
  const run = (async () => {
    try {
      const r = await fetch(t.src, { credentials: 'same-origin' });
      if (!r.ok || !r.body) throw new Error(String(r.status));
      const total = Number(r.headers.get('content-length') || 0) || t.size || 0;
      if (total > MAX_FETCH) {
        await r.body.cancel();
        set(t.src, { status: 'error', reason: 'too-large', loaded: 0, total });
        return undefined;
      }
      const reader = r.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let loaded = 0;
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        loaded += value.length;
        if (loaded > MAX_FETCH) {
          await reader.cancel();
          set(t.src, { status: 'error', reason: 'too-large', loaded, total });
          return undefined;
        }
        const now = performance.now();
        if (now - last > 120) {
          last = now;
          set(t.src, { status: 'loading', loaded, total });
        }
      }
      const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim() || t.mime || 'application/octet-stream';
      const file = new File(chunks, t.name, { type });
      set(t.src, { status: 'ready', file, loaded, total: loaded });
      trim();
      return file;
    } catch {
      set(t.src, { status: 'error', reason: 'failed', loaded: 0, total: t.size ?? 0 });
      return undefined;
    } finally {
      pending.delete(t.src);
    }
  })();
  pending.set(t.src, run);
  return run;
}

/** Fetch ahead for a later share (iOS only, files up to PREFETCH_MAX). */
export function prefetchFile(t: SaveTarget | undefined): void {
  if (!t || !shareMode() || (t.size && t.size > PREFETCH_MAX)) return;
  const e = entries.get(t.src);
  if (e?.status === 'ready' || e?.status === 'loading') return;
  void fetchFile(t);
}

export function useFileEntry(src: string | undefined): FileEntry | undefined {
  useSyncExternalStore(subscribe, () => version);
  return src ? entries.get(src) : undefined;
}

// ── The task shown by a SaveDock: progress, "tap to save", an error or a short note ──────────────────────

export type Scope = 'conv' | 'lightbox' | 'viewer' | 'gallery';
export type Task =
  | { id: number; scope: Scope; kind: 'share'; target: SaveTarget; error?: 'unshareable' | 'failed' }
  | { id: number; scope: Scope; kind: 'shareMany'; targets: SaveTarget[]; error?: 'unshareable' }
  | { id: number; scope: Scope; kind: 'note'; text: 'copied' | 'copyFailed' };

let task: Task | null = null;
let taskSeq = 0;
let noteTimer = 0;
function setTask(t: Task | null) {
  window.clearTimeout(noteTimer);
  task = t;
  if (t?.kind === 'note') {
    const id = t.id;
    noteTimer = window.setTimeout(() => task?.id === id && setTask(null), 2200);
  }
  emit();
}
export const dismissTask = () => setTask(null);

export function useTask(scope: Scope): Task | null {
  useSyncExternalStore(subscribe, () => version);
  return task?.scope === scope ? task : null;
}

/** Opens the share sheet now (must run inside a tap). false: these files cannot be shared. */
function shareNow(file: File | File[]): boolean {
  const data = { files: Array.isArray(file) ? file : [file] };
  if (!navigator.canShare(data)) return false;
  navigator.share(data).catch((e: unknown) => {
    // Dismissed (AbortError), or another share still on screen (InvalidStateError): nothing to report.
    if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'InvalidStateError')) return;
    if (e instanceof DOMException && e.name === 'NotAllowedError') return; // the tap's activation ran out
  });
  return true;
}

function download(t: SaveTarget) {
  const a = document.createElement('a');
  a.href = t.src;
  a.download = t.name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
}

/**
 * Save / share, called synchronously from a tap or click. 'download' (desktop), 'shared' (sheet opened),
 * 'waiting' (fetching: the dock of `scope` shows the progress, then the button for the second tap).
 */
export function saveFile(t: SaveTarget, scope: Scope): 'download' | 'shared' | 'waiting' {
  if (!shareMode()) {
    download(t);
    return 'download';
  }
  const e = entries.get(t.src);
  if (e?.status === 'ready') {
    if (shareNow(e.file)) {
      if (task?.kind === 'share' && task.target.src === t.src) setTask(null);
      return 'shared';
    }
    setTask({ id: ++taskSeq, scope, kind: 'share', target: t, error: 'unshareable' });
    return 'waiting';
  }
  if (e?.status === 'error') entries.delete(t.src);
  setTask({ id: ++taskSeq, scope, kind: 'share', target: t });
  void fetchFile(t);
  return 'waiting';
}

/** The dock's "Tap to save" button: the file is ready by now. */
export function shareReady(t: SaveTarget): void {
  const e = entries.get(t.src);
  if (e?.status !== 'ready') return;
  if (shareNow(e.file)) setTask(null);
  else if (task?.kind === 'share') setTask({ ...task, error: 'unshareable' });
}

/** Several files at once (the chat's media page): one share sheet with all of them, or downloads one after another. */
export function saveMany(ts: SaveTarget[], scope: Scope): 'download' | 'shared' | 'waiting' {
  if (!ts.length) return 'shared';
  if (ts.length === 1) return saveFile(ts[0]!, scope);
  if (!shareMode()) {
    // A short pause between downloads: browsers drop clicks that come too close together.
    ts.forEach((t, i) => window.setTimeout(() => download(t), i * 350));
    return 'download';
  }
  const ready = ts.map((t) => entries.get(t.src)).filter((e): e is Extract<FileEntry, { status: 'ready' }> => e?.status === 'ready');
  if (ready.length === ts.length) {
    if (shareNow(ready.map((e) => e.file))) return 'shared';
    setTask({ id: ++taskSeq, scope, kind: 'shareMany', targets: ts, error: 'unshareable' });
    return 'waiting';
  }
  setTask({ id: ++taskSeq, scope, kind: 'shareMany', targets: ts });
  for (const t of ts) {
    if (entries.get(t.src)?.status === 'error') entries.delete(t.src);
    void fetchFile(t);
  }
  return 'waiting';
}

/** Progress of several files together, for the dock. */
export function manyState(ts: SaveTarget[]): { status: 'loading' | 'ready' | 'error'; loaded: number; total: number; tooLarge: boolean } {
  let loaded = 0;
  let total = 0;
  let ready = 0;
  let error = false;
  let tooLarge = false;
  for (const t of ts) {
    const e = entries.get(t.src);
    loaded += e?.loaded ?? 0;
    total += e?.total || t.size || 0;
    if (e?.status === 'ready') ready++;
    if (e?.status === 'error') {
      error = true;
      if (e.reason === 'too-large') tooLarge = true;
    }
  }
  return { status: error ? 'error' : ready === ts.length ? 'ready' : 'loading', loaded, total, tooLarge };
}

/** The dock's "Tap to share" for several files: all ready by now. */
export function shareManyReady(ts: SaveTarget[]): void {
  const files = ts.map((t) => entries.get(t.src)).flatMap((e) => (e?.status === 'ready' ? [e.file] : []));
  if (files.length !== ts.length) return;
  if (shareNow(files)) setTask(null);
  else if (task?.kind === 'shareMany') setTask({ ...task, error: 'unshareable' });
}

/** Retry the failed ones of several files. */
export function retryMany(ts: SaveTarget[]): void {
  for (const t of ts) if (entries.get(t.src)?.status === 'error') retryFetch(t);
}

/** The dock's Retry after a failed fetch. */
export function retryFetch(t: SaveTarget): void {
  entries.delete(t.src);
  if (task?.kind === 'share') setTask({ ...task, error: undefined });
  void fetchFile(t);
}

// ── Copy image ────────────────────────────────────────────────────────────────────────────────────────

/** Images can be put on the clipboard (Safari 13.1+, Chromium): PNG through the async Clipboard API. */
export function canCopyImage(): boolean {
  if (typeof ClipboardItem !== 'function' || typeof navigator.clipboard?.write !== 'function' || !window.isSecureContext) return false;
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  return typeof supports !== 'function' || supports('image/png');
}

async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  let source: CanvasImageSource & { width: number; height: number };
  let url: string | undefined;
  try {
    source = await createImageBitmap(blob);
  } catch {
    url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    source = img;
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d')!.drawImage(source, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png'))), 'image/png'));
  } finally {
    if (url) URL.revokeObjectURL(url);
    if ('close' in source && typeof source.close === 'function') source.close();
  }
}

/**
 * Copy the picture, called synchronously from the tap: the ClipboardItem is built at once around a promise
 * (Safari requires the write to start inside the gesture; the PNG conversion happens inside the promise).
 */
export function copyImage(t: SaveTarget, scope: Scope): void {
  const ready = entries.get(t.src);
  const png = (async () => {
    const blob = ready?.status === 'ready' ? ready.file : await fetch(t.src, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
    return toPng(blob);
  })();
  navigator.clipboard
    .write([new ClipboardItem({ 'image/png': png })])
    .then(
      () => setTask({ id: ++taskSeq, scope, kind: 'note', text: 'copied' }),
      () => setTask({ id: ++taskSeq, scope, kind: 'note', text: 'copyFailed' }),
    );
}
