// iOS launch images (apple-touch-startup-image): the app's splash (boot.css .splash: the 72 pt mark centred on
// the page background), light and dark, portrait and landscape, for the iPhones and iPads iOS 17+ runs on.
// Writes client/public/splash/*.png and the <link> tags between the splash markers of client/index.html.
// Run after changing the colours or the device list: npm run splash (the output is committed).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appleSplashScreenSizes, createAppleSplashScreens } from '@vite-pwa/assets-generator/config';
import { instructions } from '@vite-pwa/assets-generator/api/instructions';

const root = fileURLToPath(new URL('../client/', import.meta.url));
const OUT = 'splash';
// Same tokens as boot.css (--bg, --accent) and .gate-mark (72 px, opacity 0.9).
const THEMES = { light: { bg: '#f4f5f7', mark: '#5b7c99' }, dark: { bg: '#14191e', mark: '#7a9bb8' } };
const MARK_PT = 72;

// Drawn large so the rasterised SVG is only ever scaled down (sharp renders SVGs at their own size).
const svg = (fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="${fill}" fill-opacity="0.9"/></svg>`);

// Devices still on a supported iOS (the 4" SE and the 5.5" Plus models stop at iOS 15/16), plus the M4 iPad Pros.
const skip = new Set(['640x1136', '1242x2208']);
const extra = { 'iPad Pro 13" M4': { width: 2064, height: 2752, scaleFactor: 2 }, 'iPad Pro 11" M4': { width: 1668, height: 2420, scaleFactor: 2 } };
const seen = new Set();
const devices = Object.entries({ ...appleSplashScreenSizes, ...extra })
  .filter(([, s]) => {
    const k = `${s.width}x${s.height}`;
    if (skip.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .map(([name]) => name);

const splash = createAppleSplashScreens(
  {
    resizeOptions: { fit: 'contain', background: THEMES.light.bg },
    darkResizeOptions: { fit: 'contain', background: THEMES.dark.bg },
    darkImageResolver: async () => svg(THEMES.dark.mark),
    linkMediaOptions: { log: false, addMediaScreen: true, basePath: `/${OUT}/`, xhtml: false },
    png: { compressionLevel: 9, quality: 60 },
    name: (landscape, size, dark) => `${dark ? 'dark' : 'light'}-${landscape ? 'landscape' : 'portrait'}-${size.width}x${size.height}.png`,
  },
  devices,
  extra,
);
// The mark keeps its size in points: the padding leaves exactly MARK_PT around the centre (contain fits the shorter side).
for (const s of splash.sizes) s.padding = 1 - (MARK_PT * s.scaleFactor) / Math.min(s.width, s.height);

const empty = { sizes: [], padding: 0, resizeOptions: {} };
const ins = await instructions({
  imageResolver: () => svg(THEMES.light.mark),
  imageName: 'splash.png',
  preset: { transparent: empty, maskable: empty, apple: empty, appleSplashScreens: splash },
  htmlLinks: { xhtml: false, includeId: false },
  basePath: '/',
  resolveSvgName: (n) => n,
});

const dir = `${root}public/${OUT}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const links = [];
for (const a of Object.values(ins.appleSplashScreen)) {
  writeFileSync(`${dir}/${a.name}`, await a.buffer());
  // Light explicitly too: without it, a light link also matches in dark mode and iOS may pick it.
  links.push(a.name.startsWith('dark-') ? a.link : a.link.replace('media="screen and ', 'media="screen and (prefers-color-scheme: light) and '));
}

const html = readFileSync(`${root}index.html`, 'utf8');
const re = /<!-- splash:start -->[\s\S]*?<!-- splash:end -->/;
if (!re.test(html)) throw new Error('index.html: splash markers missing');
const block = ['<!-- splash:start -->', ...links, '<!-- splash:end -->'].join('\n    ');
writeFileSync(`${root}index.html`, html.replace(re, () => block));
console.log(`${links.length} launch images in client/public/${OUT}/`);
