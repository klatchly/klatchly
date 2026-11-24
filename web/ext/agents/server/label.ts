// The fallback without a manifest (KLATCHLY_AGENTS_FILE, manifest.ts): every agent's disclosure, the configuration's,
// never a name of the code's.
// KLATCHLY_AGENTS_LABEL is where the chat's messages go at each call (the agent runtime, and the model behind it if the
// instance wants it said): a plain name for every language, or {"en": …, "fr": …} (English required). Unset or
// malformed: no name, and the line says only "the agent".

/** KLATCHLY_AGENTS_LABEL, read at each call: a name by language code (`en` always there), or null. */
export function agentsLabel(): Readonly<Record<string, string>> | null {
  const raw = (process.env.KLATCHLY_AGENTS_LABEL ?? '').trim();
  if (!raw) return null;
  if (!raw.startsWith('{')) return { en: raw };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v)) if (/^[a-z]{2,3}(-[A-Z]{2})?$/.test(k) && typeof x === 'string' && x.trim()) out[k] = x.trim();
    return 'en' in out ? out : null;
  } catch {
    return null;
  }
}
