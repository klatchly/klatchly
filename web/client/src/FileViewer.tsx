// A file attachment opened inside the app: a full-screen page over the chat with Back (✕ / Esc / the phone's
// Back, see Conversation), the file's name and Save / Share. PDFs are drawn by pdf.js (PdfView, own chunk); HTML
// files are shown sandboxed (no scripts, nothing fetched: the server's htmlview.ts); other files get a card.
// Never navigates the app (iOS Home Screen apps have no way back from a file).
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MediaTarget } from './attach';
import { extLabel, extOf, fileKind, normName, splitName } from './files';
import { FileIcon } from './FileIcon';
import { fileSize } from './format';
import { useT } from './i18n';
import { lazyChunk, Lazy } from './lazy';
import { fetchFile, prefetchFile, saveFile, shareMode, useFileEntry } from './save';
import { SaveDock } from './SaveDock';

const PdfView = lazyChunk(() => import('./PdfView'), 'PdfView');
const ZOOMS = [1, 1.5, 2, 3];

export function FileViewer({ target, onClose }: { target: MediaTarget; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const a = target.att;
  const name = normName(a.fileName) || target.name;
  const kind = fileKind(a.fileName, a.mimeType);
  const { head, tail } = splitName(name);
  const pdf = target.preview === 'pdf';
  const html = target.preview === 'html';
  const entry = useFileEntry(pdf || html ? target.src : undefined);
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [page, setPage] = useState<string | null>(null);
  const [pages, setPages] = useState(0);
  const [broken, setBroken] = useState<string | false>(false);
  const [zoom, setZoom] = useState(0);
  const share = shareMode();

  useLayoutEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    document.documentElement.classList.add('lb-open');
    return () => document.documentElement.classList.remove('lb-open');
  }, []);

  // A PDF is read whole once: pdf.js draws it from memory, and the same File is ready for the share sheet.
  // Other files are only fetched ahead for the share sheet (iOS).
  // An HTML file: its bytes go to the server once, which serves them back sandboxed for the frame.
  useEffect(() => {
    if (!html) return;
    let dead = false;
    void fetchFile(target).then(async (f) => {
      if (dead) return;
      if (!f) return setBroken('fetch');
      const r = await fetch('/api/htmlview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: f }).catch(() => null);
      const id = r?.ok ? ((await r.json().catch(() => null)) as { id?: string } | null)?.id : undefined;
      if (dead) return;
      if (r?.status === 413) return setBroken('too-large');
      if (!id || !/^[a-f0-9]{32}$/.test(id)) return setBroken('html');
      setPage(`/api/htmlview/${id}`);
    });
    return () => {
      dead = true;
    };
  }, [html, target]);

  useEffect(() => {
    if (html) return;
    if (!pdf) return prefetchFile(target);
    let dead = false;
    void fetchFile(target).then(async (f) => {
      if (dead) return;
      if (!f) return setBroken('fetch');
      const buf = await f.arrayBuffer();
      if (!dead) setData(buf);
    });
    return () => {
      dead = true;
    };
  }, [html, pdf, target]);

  const details = [pages ? t.media.pages(pages) : fileSize(a.fileSize), extLabel(a.fileName, a.mimeType)].filter(Boolean).join(' · ');
  const save = () => saveFile(target, 'viewer');
  const saveLabel = share ? t.media.saveShare : t.media.download;
  const saveIcon = share ? (
    <path d="M12 15V4M8 8l4-4 4 4M6 12v7h12v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  ) : (
    <path d="M12 4v11M7 10l5 5 5-5M5 19h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  );
  const pct = entry?.status === 'loading' && entry.total ? Math.min(99, Math.floor((entry.loaded / entry.total) * 100)) : null;
  const failed = broken || entry?.status === 'error';

  return (
    <dialog
      ref={dialog}
      className="file-viewer"
      aria-label={t.media.viewer}
      data-testid="file-viewer"
      data-kind={kind}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="fv-bar">
        <button type="button" className="icon-btn" aria-label={t.common.back} title={t.common.back} data-testid="fv-back" autoFocus onClick={onClose}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="fv-title">
          <span className="fv-name" data-testid="fv-name" title={name}>
            {head && <span className="att-file-head">{head}</span>}
            <span className="att-file-tail">{tail}</span>
          </span>
          {details && <span className="fv-sub">{details}</span>}
        </div>
        {pdf && data && !failed && (
          <span className="pdf-zoom">
            <button type="button" className="icon-btn" aria-label={t.media.zoomOut} title={t.media.zoomOut} disabled={zoom === 0} onClick={() => setZoom((z) => Math.max(0, z - 1))}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M8 11h6M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            <button type="button" className="icon-btn" aria-label={t.media.zoomIn} title={t.media.zoomIn} disabled={zoom === ZOOMS.length - 1} data-testid="fv-zoom-in" onClick={() => setZoom((z) => Math.min(ZOOMS.length - 1, z + 1))}>
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M8 11h6M11 8v6M16 16l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        )}
        <button type="button" className="icon-btn" aria-label={saveLabel} title={saveLabel} data-testid="fv-save" onClick={save}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            {saveIcon}
          </svg>
        </button>
      </div>
      <div className="fv-body" data-testid="fv-body">
        {html && !failed && page ? (
          <iframe
            className="fv-html"
            src={page}
            title={name}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer"
            data-testid="fv-html"
          />
        ) : !pdf && !html ? (
          <div className="fv-card" data-testid="fv-card">
            <FileIcon kind={kind} ext={extOf(a.fileName, a.mimeType)} size={72} />
            <div className="fv-card-name">{name}</div>
            <div className="fv-card-sub">{[t.media.kinds[kind], fileSize(a.fileSize)].filter(Boolean).join(' · ')}</div>
            <div className="fv-card-sub">{t.media.noPreview}</div>
            <button type="button" className="primary-btn" data-testid="fv-card-save" onClick={save}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                {saveIcon}
              </svg>
              {saveLabel}
            </button>
          </div>
        ) : failed ? (
          <div className="fv-status" role="alert" data-testid="fv-error" data-why={broken || entry?.status}>
            {broken === 'too-large' || (entry?.status === 'error' && entry.reason === 'too-large') ? t.media.tooLarge : t.media.previewFailed}
            <button type="button" className="text-btn" onClick={save}>
              {saveLabel}
            </button>
          </div>
        ) : !data ? (
          <div className="fv-status" role="status" data-testid="fv-loading">
            {t.media.loadingFile}
            <span className="fv-progress" aria-hidden="true">
              <span style={{ width: pct === null ? undefined : `${pct}%` }} className={pct === null ? 'indeterminate' : ''} />
            </span>
          </div>
        ) : (
          <Lazy failed={null} onError={() => setBroken('chunk')} fallback={<div className="fv-status" role="status">{t.media.loadingFile}</div>}>
            <PdfView data={data} zoom={ZOOMS[zoom]!} onLoaded={setPages} onError={setBroken} />
          </Lazy>
        )}
      </div>
      <SaveDock scope="viewer" />
    </dialog>
  );
}
