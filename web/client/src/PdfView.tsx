// PDF pages drawn by pdf.js (own chunk, loaded when a PDF is opened). The browser's own PDF viewer is not
// used: in the iOS Home Screen app a PDF in a frame shows its first page only, and opening it navigates the
// app away. Pages are canvases at the width of the screen (× zoom), drawn when near the viewport and freed
// when far from it (iOS caps the memory of all canvases of a page). No scripting (pdf.js 6 has no eval left),
// no WebAssembly (the page CSP has no 'wasm-unsafe-eval': pdf.js uses its JS decoders).
import { useEffect, useRef, useState } from 'react';
// The legacy build: the modern one relies on the newest JavaScript (Map.prototype.getOrInsertComputed,
// Math.sumPrecise...) that Safari and Chromium do not all have yet; this one carries polyfills.
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

// Copied next to the app at build time (vite.config.ts pdfAssets): CMaps for CJK text, standard fonts for PDFs
// that do not embed theirs, the non-WebAssembly image decoders (JPEG 2000, JBIG2).
const ASSETS = new URL('/pdfjs/', location.origin).href;
// One canvas at most this many pixels (Safari refuses bigger ones), drawn at the device's pixel ratio below it.
const MAX_PIXELS = 12_000_000;
const KEEP_MARGIN = '1200px 0px';

export function PdfView({ data, zoom, onLoaded, onError }: { data: ArrayBuffer; zoom: number; onLoaded: (pages: number) => void; onError: (why: string) => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 612, h: 792 });
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const cb = useRef({ onLoaded, onError });
  cb.current = { onLoaded, onError };

  useEffect(() => {
    let dead = false;
    // pdf.js transfers the buffer to its worker: give it a copy, the File keeps the original for sharing.
    const task = getDocument({
      data: new Uint8Array(data.slice(0)),
      enableXfa: false,
      useWasm: false,
      wasmUrl: `${ASSETS}wasm/`,
      cMapUrl: `${ASSETS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${ASSETS}standard_fonts/`,
      iccUrl: `${ASSETS}iccs/`,
    });
    task.promise.then(
      async (d) => {
        if (dead) return;
        const first = await d.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (dead) return;
        setSize({ w: vp.width, h: vp.height });
        setDoc(d);
        cb.current.onLoaded(d.numPages);
      },
      (e: unknown) => !dead && cb.current.onError(e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : 'error'),
    );
    return () => {
      dead = true;
      void task.destroy();
    };
  }, [data]);

  // Fit the width of the viewer (minus a small margin), then the zoom.
  useEffect(() => {
    const el = box.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth - 16)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pageW = Math.round(width * zoom);
  return (
    <div className="pdf-pages" ref={box} data-testid="pdf-pages" data-pages={doc?.numPages ?? 0}>
      {doc && pageW > 0 && Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} width={pageW} guess={size} />)}
    </div>
  );
}

function PdfPage({ doc, n, width, guess }: { doc: PDFDocumentProxy; n: number; width: number; guess: { w: number; h: number } }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(n <= 2);
  const [ratio, setRatio] = useState(guess.h / guess.w);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { root: el.closest('.fv-body'), rootMargin: KEEP_MARGIN });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!near || !c) {
      // Far away: free the bitmap.
      if (c) {
        c.width = 0;
        c.height = 0;
      }
      setDrawn(false);
      return;
    }
    let dead = false;
    let task: RenderTask | undefined;
    let page: PDFPageProxy | undefined;
    void doc.getPage(n).then((p) => {
      if (dead) return;
      page = p;
      const base = p.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const cssScale = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_PIXELS / (base.width * cssScale * base.height * cssScale)));
      const vp = p.getViewport({ scale: cssScale * dpr });
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = p.render({ canvas: c, viewport: vp });
      task.promise.then(
        () => !dead && setDrawn(true),
        () => {},
      );
    });
    return () => {
      dead = true;
      task?.cancel();
      page?.cleanup();
    };
  }, [near, doc, n, width]);

  return (
    <div ref={wrap} className={`pdf-page ${drawn ? 'drawn' : ''}`} style={{ width, height: Math.round(width * ratio) }} data-testid="pdf-page" data-drawn={drawn ? '1' : undefined}>
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}
