import type { Redraw } from './attachprep';

const QUALITIES = [0.9, 0.8, 0.7];
const MAX_TRIES = 8;

/**
 * A picture re-encoded on a canvas (attachprep.ts prepareFile), JPEG on white (it has no transparency). Within
 * `maxBytes`: a JPEG at lower qualities, then redrawn smaller (0.75 of its sides each time) until it fits; a PNG
 * as it comes out (the plan then refuses it for its size, or prepareFile makes it a JPEG). null when the browser
 * cannot decode it (HEIC in most browsers) or nothing fits.
 */
export const redraw: Redraw = async (file, type, maxBytes) => {
  let bmp: ImageBitmap | undefined;
  try {
    bmp = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    if (!g) return null;
    const encode = (scale: number, quality: number) => {
      canvas.width = Math.max(1, Math.round(bmp!.width * scale));
      canvas.height = Math.max(1, Math.round(bmp!.height * scale));
      if (type === 'image/jpeg') {
        g.fillStyle = '#fff';
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      g.drawImage(bmp!, 0, 0, canvas.width, canvas.height);
      return new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, quality));
    };
    if (!maxBytes || type !== 'image/jpeg') return await encode(1, 0.92);
    let scale = 1;
    for (let i = 0; i < MAX_TRIES; i++) {
      for (const q of i === 0 ? QUALITIES : QUALITIES.slice(-1)) {
        const blob = await encode(scale, q);
        if (!blob) return null;
        if (blob.size <= maxBytes) return blob;
      }
      scale *= 0.75;
    }
    return null;
  } catch {
    return null;
  } finally {
    bmp?.close();
  }
};
