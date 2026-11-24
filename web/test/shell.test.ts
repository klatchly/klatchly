import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { inlineStyleHashes, staticCache } from '../server/shell.js';

// Source files, from build-test/test/.
const client = new URL('../../client/', import.meta.url);
const html = readFileSync(new URL('index.html', client), 'utf8');

test('index.html paints the page colour and the splash before any stylesheet or script', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const style = /<style>([\s\S]*?)<\/style>/.exec(head)?.[1] ?? '';
  // Light by default, dark under prefers-color-scheme (boot.css --bg).
  assert.match(style, /html, body \{ background: #f4f5f7; \}/);
  assert.match(style, /@media \(prefers-color-scheme: dark\) \{\s*html, body \{ background: #14191e; \}/);
  assert.match(style, /\.splash \.gate-mark \{[^}]*border-radius: 50%/);
  // The static splash is what React replaces; no inline style attribute (CSP allows the <style> by hash only).
  assert.match(html, /<div id="root"><div class="splash"><div class="gate-mark" aria-hidden="true"><\/div><\/div><\/div>/);
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
});

test('index.html links a light and a dark iOS launch image per device and orientation, all present', () => {
  const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)">/g)];
  assert.ok(links.length >= 40, `${links.length} launch images`);
  const keys = new Set<string>();
  for (const [, media, href] of links) {
    assert.ok(existsSync(new URL(`public${href!}`, client)), href);
    const dark = media!.includes('(prefers-color-scheme: dark)');
    assert.ok(dark || media!.includes('(prefers-color-scheme: light)'), media);
    assert.equal(href!.startsWith('/splash/dark-'), dark, href);
    const landscape = media!.includes('(orientation: landscape)');
    assert.ok(landscape || media!.includes('(orientation: portrait)'), media);
    const [w, h] = /-(\d+)x(\d+)\.png$/.exec(href!)!.slice(1).map(Number) as [number, number];
    assert.equal(w > h, landscape, href);
    keys.add(media!);
  }
  assert.equal(keys.size, links.length, 'one image per media query');
  // Current iPhones, light and dark, portrait (16 Pro Max / 17 Pro Max, 16 / 15, 17 / 16 Pro).
  for (const size of ['1320x2868', '1179x2556', '1206x2622'])
    for (const theme of ['light', 'dark']) assert.ok(links.some(([, , href]) => href === `/splash/${theme}-portrait-${size}.png`), `${theme} ${size}`);
});

test('inlineStyleHashes: one CSP source per <style> block (attributes or not), matching its exact text', () => {
  const css = '\n  body { background: red; }\n';
  const want = `'sha256-${createHash('sha256').update(css).digest('base64')}'`;
  assert.deepEqual(inlineStyleHashes(`<head><style>${css}</style></head>`), [want]);
  assert.equal(inlineStyleHashes(html).length, 1);
  assert.deepEqual(inlineStyleHashes('<head></head>'), []);
  // A build may add attributes (nonce-less, e.g. media or a plugin's data-*): the content is what is hashed.
  const min = 'html,body{background:#f4f5f7}';
  const minHash = `'sha256-${createHash('sha256').update(min).digest('base64')}'`;
  assert.deepEqual(inlineStyleHashes(`<style data-x="1">${min}</style><STYLE media="all">${css}</STYLE>`), [minHash, want]);
});

test('the splash colours match the boot.css tokens (index.html inline style, scripts/splash.mjs)', () => {
  const css = readFileSync(new URL('src/boot.css', client), 'utf8');
  const tokens = (block: string) => ({ bg: /--bg:\s*(#[0-9a-f]{6})/.exec(block)![1], accent: /--accent:\s*(#[0-9a-f]{6})/.exec(block)![1] });
  const light = tokens(/^:root \{[\s\S]*?\n\}/m.exec(css)![0]);
  const dark = tokens(/@media \(prefers-color-scheme: dark\) \{\s*:root \{[\s\S]*?\n {2}\}/.exec(css)![0]);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
  const [base, darkPart] = style.split('@media (prefers-color-scheme: dark)') as [string, string];
  assert.match(base, new RegExp(`html, body \\{ background: ${light.bg}; \\}`));
  assert.match(base, new RegExp(`\\.gate-mark \\{[^}]*background: ${light.accent};`));
  assert.match(darkPart, new RegExp(`html, body \\{ background: ${dark.bg}; \\}`));
  assert.match(darkPart, new RegExp(`\\.gate-mark \\{ background: ${dark.accent}; \\}`));
  const script = readFileSync(new URL('../scripts/splash.mjs', client), 'utf8');
  const themes = /const THEMES = \{ light: \{ bg: '(#\w+)', mark: '(#\w+)' \}, dark: \{ bg: '(#\w+)', mark: '(#\w+)' \} \};/.exec(script);
  assert.ok(themes, 'THEMES in scripts/splash.mjs');
  assert.deepEqual(themes.slice(1), [light.bg, light.accent, dark.bg, dark.accent]);
});

test('staticCache: hashed assets immutable, launch images a week, the rest revalidated', () => {
  assert.equal(staticCache('/assets/index-abc.js'), 'public, max-age=31536000, immutable');
  assert.equal(staticCache('/splash/dark-portrait-1179x2556.png'), 'public, max-age=604800');
  assert.equal(staticCache('/sw.js'), 'no-cache');
  assert.equal(staticCache('/icon-512.png'), 'no-cache');
});
