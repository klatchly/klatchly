// Versions and ranges of the packages (package.ts `version`, `klatchly`, `requires`, `enhances`): plain x.y.z
// versions (no pre-release or build tags) and npm-style ranges, small enough to read in one go. A range is one or
// more comparator sets joined by '||'; a set is comparators separated by spaces (all must hold): exact ('1.2.3',
// '=1.2.3'), '>', '>=', '<', '<=', caret ('^1.2.3': same major, or same minor below 1.0, or same patch below
// 0.1), tilde ('~1.2.3': same minor; '~1': same major), x-ranges ('1.x', '1.2.*', '1', '1.2', '*'). Partial
// versions fill in the usual way ('>=1.2' is '>=1.2.0', '<=1.2' is '<1.3.0', '>1.2' is '>=1.3.0'). Pure: no
// imports, shared by the server and the tests.

export type Version = readonly [number, number, number];

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
// A comparator: operator, then 1 to 3 parts, each a number or x/X/*.
const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?(?:v)?(0|[1-9]\d{0,8}|[xX*])(?:\.(0|[1-9]\d{0,8}|[xX*]))?(?:\.(0|[1-9]\d{0,8}|[xX*]))?$/;

/** A plain x.y.z version, or null. */
export function parseVersion(v: string): Version | null {
  const m = VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** One bound: the version compared with `v` must satisfy `op`. */
type Bound = { op: '>=' | '<' | '>' | '<=' | '='; v: Version };

/** The bounds of one comparator (several for ^, ~ and x-ranges), or null when it is malformed. */
function bounds(c: string): Bound[] | null {
  const m = COMPARATOR.exec(c);
  if (!m) return null;
  const op = m[1] ?? '';
  const raw = [m[2], m[3], m[4]];
  // Parts up to the first wildcard or missing one; a number after a wildcard ('1.x.3') is refused.
  const parts: number[] = [];
  for (const p of raw) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  if (raw.slice(parts.length).some((p) => p !== undefined && !/^[xX*]$/.test(p))) return null;
  const [a = 0, b = 0, d = 0] = parts;
  const n = parts.length;
  const full: Version = [a, b, d];
  // The version just above the given parts ('1.2' -> 1.3.0, '1' -> 2.0.0).
  const next = (k: number): Version => (k === 1 ? [a + 1, 0, 0] : k === 2 ? [a, b + 1, 0] : [a, b, d + 1]);
  if (n === 0) return op === '<' || op === '>' ? [{ op: '<', v: [0, 0, 0] }] : [];
  switch (op) {
    case '':
    case '=':
      return n === 3 ? [{ op: '=', v: full }] : [{ op: '>=', v: full }, { op: '<', v: next(n) }];
    case '^': {
      // The first non-zero part given is the one that may not change.
      const k = a > 0 || n === 1 ? 1 : b > 0 || n === 2 ? 2 : 3;
      return [{ op: '>=', v: full }, { op: '<', v: next(k) }];
    }
    case '~':
      return [{ op: '>=', v: full }, { op: '<', v: next(n === 1 ? 1 : 2) }];
    case '>=':
      return [{ op: '>=', v: full }];
    case '<':
      return [{ op: '<', v: full }];
    case '>':
      return n === 3 ? [{ op: '>', v: full }] : [{ op: '>=', v: next(n) }];
    case '<=':
      return n === 3 ? [{ op: '<=', v: full }] : [{ op: '<', v: next(n) }];
  }
  return null;
}

const holds = (v: Version, b: Bound): boolean => {
  const c = cmp(v, b.v);
  return b.op === '=' ? c === 0 : b.op === '>=' ? c >= 0 : b.op === '>' ? c > 0 : b.op === '<' ? c < 0 : c <= 0;
};

/** The comparator sets of a range (null if any part is malformed). */
function sets(range: string): Bound[][] | null {
  if (range.length > 200) return null;
  const alts = range.split('||').map((s) => s.trim());
  const out: Bound[][] = [];
  for (const alt of alts) {
    if (!alt) return null;
    // '>= 1.2' is read as '>=1.2'.
    const words = alt.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
    const all: Bound[] = [];
    for (const w of words) {
      const b = bounds(w);
      if (!b) return null;
      all.push(...b);
    }
    out.push(all);
  }
  return out;
}

/** Why a range cannot be read (null: it can). */
export const rangeProblem = (range: string): string | null => (sets(range) ? null : `bad range ${JSON.stringify(range)}`);

/** Whether a plain version satisfies a range (false for a malformed version or range). */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const s = sets(range);
  return !!v && !!s && s.some((set) => set.every((b) => holds(v, b)));
}

/** The bump from `from` to `to`: 'major', 'minor', 'patch', 'none', or 'down' when `to` is lower. */
export function bumpOf(from: string, to: string): 'major' | 'minor' | 'patch' | 'none' | 'down' {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return 'down';
  const c = cmp(b, a);
  if (c < 0) return 'down';
  if (c === 0) return 'none';
  return b[0] > a[0] ? 'major' : b[1] > a[1] ? 'minor' : 'patch';
}

/** The next version for a bump ('1.4.2', 'minor' -> '1.5.0'). */
export function bumped(version: string, kind: 'major' | 'minor' | 'patch'): string {
  const [a, b, d] = parseVersion(version) ?? [0, 0, 0];
  return kind === 'major' ? `${a + 1}.0.0` : kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${d + 1}`;
}
