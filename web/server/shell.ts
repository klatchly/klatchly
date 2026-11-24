import { createHash } from 'node:crypto';

/**
 * CSP sources for the inline <style> blocks of index.html (the first-paint shell: page colour and splash),
 * computed from the built file so the policy keeps 'self' only plus exactly these blocks.
 */
export function inlineStyleHashes(html: string): string[] {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
}

/**
 * Cache-Control of a static file: hashed build assets forever; iOS launch images for a week (fixed names,
 * regenerated rarely, read by iOS when the app is added to the Home Screen); the rest revalidated.
 */
export function staticCache(path: string): string {
  if (path.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (path.startsWith('/splash/')) return 'public, max-age=604800';
  return 'no-cache';
}
