// Small media for the offline fakes: pictures drawn by sharp, and a few recorded files (fixtures/: a 2 s test-pattern
// clip, a 3 s tone as an Opus voice note), plus a one-page PDF written here.
import { readFileSync } from 'node:fs';

const { default: sharp } = await import('sharp');

/** A picture: a gradient of `color` with a grid, as JPEG (or PNG). */
export async function picture(width, height, color, format = 'jpeg') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#223"/></linearGradient>
    <pattern id="p" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#fff" stroke-opacity=".3"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#p)"/></svg>`;
  const img = sharp(Buffer.from(svg));
  return format === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 80 }).toBuffer();
}

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
export const clip = () => fixture('clip.webm');
export const voice = () => fixture('voice.ogg');

/** A one-page PDF with a title line. */
export function pdf(title) {
  const text = title.replace(/[()\\]/g, '');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 28 Tf 72 760 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Width and height of a picture (uploads). */
export async function size(buf) {
  try {
    const m = await sharp(buf).metadata();
    return m.width && m.height ? { width: m.width, height: m.height } : null;
  } catch {
    return null;
  }
}
