// An account id as one URL segment of the space (/networks/<slug>), shared by both halves. Not in package.ts, which
// is on the launch path: only the space's chunk and the server need it.

// Desktop API account ids are matrix, discordgo, slackgo.TEAM-USER, local-whatsapp_ba_…: letters, digits and a few
// marks. Letters, digits and '-' stay; any other byte (UTF-8) becomes '_' and two hex digits ('_' itself: '_5f').
const KEEP = /[A-Za-z0-9-]/;

/** An account id as one URL segment of the space (reversible, matches networksSpace.segment). */
export function accountSlug(id: string): string {
  let out = '';
  for (const ch of id) {
    if (KEEP.test(ch)) out += ch;
    else for (const b of new TextEncoder().encode(ch)) out += `_${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

/** The account id of a segment, or null for one accountSlug does not make. */
export function slugAccount(slug: string): string | null {
  if (!/^(?:[A-Za-z0-9-]|_[0-9a-f]{2})+$/.test(slug)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < slug.length; ) {
    if (slug[i] === '_') {
      bytes.push(parseInt(slug.slice(i + 1, i + 3), 16));
      i += 3;
    } else bytes.push(slug.charCodeAt(i++));
  }
  try {
    const id = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    return accountSlug(id) === slug ? id : null;
  } catch {
    return null;
  }
}
