import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'rolldown/utils';
import { bumped, bumpOf } from '../server/semver.js';

// What an API exposes, as text to compare (test/contract.test.ts for the core's extension API, ext/contracts.test.ts
// for the packages' public entries): every exported declaration of the entry files, and the declarations of the
// same code base they refer to (a type a field uses, an interface a type extends), one entry per member:
// 'server/registry.ts#ModuleContext.provider' -> '<P extends ProviderModule = ProviderModule>(id:string):P|undefined'.
// Signatures only: comments, formatting and function bodies are left out, and a constant's value (EXTENSION_API)
// is not part of it. Parsed with the parser vite already brings (rolldown's, oxc), no new dependency.

const WEB = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Entry key -> normalized signature. */
export type Fingerprint = Record<string, string>;

// The parser's tree, loosely typed: only what is read here.
type Node = { type: string; start: number; end: number } & Record<string, any>;

interface Unit {
  file: string;
  src: string;
  comments: { start: number; end: number }[];
  /** Top-level declarations by name (exported or not). */
  decls: Map<string, Node>;
  /** Local name -> where it comes from (another file of the code base). */
  imports: Map<string, { file: string; name: string }>;
  /** Exported name -> local name, or a re-export from another file. */
  exports: Map<string, { local: string } | { file: string; name: string }>;
}

const units = new Map<string, Unit | null>();

/** The file a specifier points at, relative to web/ (null: a dependency, or outside `within`). */
function target(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = relative(WEB, resolve(dirname(join(WEB, from)), spec));
  else if (spec.startsWith('#core/')) base = `server/${spec.slice(6)}`;
  else if (spec.startsWith('#ext/')) base = `ext/${spec.slice(5)}`;
  else return null;
  base = base.split(sep).join('/').replace(/\.(js|ts|tsx)$/, '');
  for (const ext of ['.ts', '.tsx']) if (existsSync(join(WEB, base + ext))) return base + ext;
  return null;
}

const nameOf = (n: Node | undefined): string | undefined => (n ? (n.type === 'Identifier' ? n.name : typeof n.value === 'string' ? n.value : undefined) : undefined);

function load(file: string): Unit | null {
  if (units.has(file)) return units.get(file)!;
  const src = readFileSync(join(WEB, file), 'utf8');
  const r = parseSync(file, src, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', sourceType: 'module' }) as unknown as { program: Node; comments: Node[] };
  const u: Unit = { file, src, comments: r.comments, decls: new Map(), imports: new Map(), exports: new Map() };
  const declare = (d: Node | null | undefined, exported: boolean) => {
    if (!d) return;
    const names = d.type === 'VariableDeclaration' ? d.declarations.map((x: Node) => nameOf(x.id)) : [nameOf(d.id)];
    for (const n of names) {
      if (!n) continue;
      // A variable is fingerprinted by its declarator; the rest by the declaration.
      u.decls.set(n, d.type === 'VariableDeclaration' ? { ...d.declarations.find((x: Node) => nameOf(x.id) === n), kind: d.kind } : d);
      if (exported) u.exports.set(n, { local: n });
    }
  };
  for (const s of r.program.body as Node[]) {
    if (s.type === 'ImportDeclaration') {
      const f = target(file, s.source.value);
      if (f) for (const sp of s.specifiers as Node[]) if (sp.type === 'ImportSpecifier') u.imports.set(sp.local.name, { file: f, name: nameOf(sp.imported)! });
    } else if (s.type === 'ExportAllDeclaration') {
      // What it re-exports is not written here: the fingerprint would miss it. Name each export instead.
      throw new Error(`${file}: export * cannot be fingerprinted; export each name`);
    } else if (s.type === 'ExportNamedDeclaration') {
      declare(s.declaration, true);
      const f = s.source ? target(file, s.source.value) : null;
      for (const sp of (s.specifiers ?? []) as Node[]) {
        const local = nameOf(sp.local)!;
        const exported = nameOf(sp.exported)!;
        if (s.source) {
          if (f) u.exports.set(exported, { file: f, name: local });
        } else u.exports.set(exported, { local });
      }
    } else declare(s, false);
  }
  units.set(file, u);
  return u;
}

/** A slice of the source without its comments, its whitespace reduced, separators at the end dropped. */
function text(u: Unit, start: number, end: number): string {
  let out = '';
  let at = start;
  for (const c of u.comments) {
    if (c.end <= start || c.start >= end) continue;
    out += u.src.slice(at, Math.max(at, c.start));
    at = Math.max(at, c.end);
  }
  out += u.src.slice(at, end);
  return out
    .replace(/^\s*export\s+(default\s+)?/, '')
    .replace(/\s+/g, ' ')
    .replace(/ (?=[^\w$])|(?<=[^\w$]) /g, '')
    .replace(/[,;]+(?=[)\]}>])/g, '')
    .replace(/[,;]+$/, '')
    .trim();
}

/** Every node under `n` (its fields, depth first), but not the bodies of functions. */
function walk(n: unknown, visit: (n: Node) => void): void {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) {
    for (const x of n) walk(x, visit);
    return;
  }
  const node = n as Node;
  if (typeof node.type === 'string') visit(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'body' && (node.type.includes('Function') || node.type === 'ArrowFunctionExpression')) continue;
    if (k === 'value' && node.type === 'MethodDefinition') {
      walk({ ...v, body: undefined }, visit);
      continue;
    }
    if (k === 'init' && node.type === 'VariableDeclarator' && v && !/Function/.test((v as Node).type)) continue;
    if (k === 'value' && node.type === 'PropertyDefinition') continue;
    walk(v, visit);
  }
}

const memberKey = (m: Node): string | null => {
  if (m.type === 'TSCallSignatureDeclaration') return '()';
  if (m.type === 'TSConstructSignatureDeclaration') return 'new()';
  if (m.type === 'TSIndexSignature') return '[]';
  if (m.key?.type === 'PrivateIdentifier' || m.accessibility === 'private' || m.accessibility === 'protected') return null;
  const k = nameOf(m.key);
  return k === undefined ? null : `${m.static ? 'static ' : ''}${k}${m.kind === 'get' || m.kind === 'set' ? `:${m.kind}` : ''}`;
};

/** The entries of one declaration (under `key`), and the names it refers to. */
function entries(u: Unit, key: string, d: Node, out: Fingerprint): string[] {
  const t = (n: Node) => text(u, n.start, n.end);
  const members = (list: Node[]) => {
    for (const m of list) {
      const k = memberKey(m);
      if (k === null) continue;
      const end = m.type === 'MethodDefinition' && m.value?.body ? m.value.body.start : m.type === 'PropertyDefinition' ? (m.typeAnnotation?.end ?? m.key.end) : m.end;
      out[`${key}.${k}`] = text(u, m.start, end);
    }
  };
  if (d.type === 'TSInterfaceDeclaration') {
    out[key] = text(u, d.start, d.body.start);
    members(d.body.body);
  } else if (d.type === 'TSTypeAliasDeclaration' && d.typeAnnotation.type === 'TSTypeLiteral') {
    out[key] = `${text(u, d.start, d.typeAnnotation.start)}{}`;
    members(d.typeAnnotation.members);
  } else if (d.type === 'FunctionDeclaration' || d.type === 'TSDeclareFunction') {
    out[key] = text(u, d.start, d.body?.start ?? d.end);
  } else if (d.type === 'ClassDeclaration') {
    out[key] = text(u, d.start, d.body.start);
    members(d.body.body);
  } else if (d.type === 'VariableDeclarator') {
    // Its annotation, or a function's signature; any other value is not the API's shape.
    const init = d.init as Node | null;
    out[key] = d.id.typeAnnotation
      ? `${d.kind}:${t(d.id.typeAnnotation)}`
      : init && /Function/.test(init.type)
        ? `${d.kind} ${text(u, init.start, init.body.start)}`
        : init?.type === 'CallExpression' && nameOf(init.callee)
          ? `${d.kind}=${nameOf(init.callee)}(…)`
          : `${d.kind} value`;
  } else {
    out[key] = t(d);
  }
  const refs = new Set<string>();
  walk(d, (n) => {
    const id =
      n.type === 'TSTypeReference' || n.type === 'TSTypeQuery'
        ? (n.typeName ?? n.exprName)
        : n.type === 'TSInterfaceHeritage' || n.type === 'TSClassImplements'
          ? n.expression
          : null;
    let root = id as Node | null;
    while (root && root.type === 'TSQualifiedName') root = root.left;
    if (root?.type === 'Identifier') refs.add(root.name);
  });
  if (d.type === 'ClassDeclaration' && d.superClass?.type === 'Identifier') refs.add(d.superClass.name);
  return [...refs];
}

/**
 * The fingerprint of `entryFiles`' exports (paths relative to web/), following references into files under
 * `within` (path prefixes).
 */
export function fingerprint(entryFiles: readonly string[], within: readonly string[], skip: readonly string[] = []): Fingerprint {
  const out: Fingerprint = {};
  const done = new Set<string>();
  const inside = (f: string) => within.some((w) => f.startsWith(w));
  // A name as seen from a file: its own declaration there, or where it was imported from.
  const resolveName = (file: string, name: string, depth = 0): { u: Unit; name: string } | null => {
    const u = inside(file) ? load(file) : null;
    if (!u || depth > 20) return null;
    if (u.decls.has(name)) return { u, name };
    const imp = u.imports.get(name);
    return imp ? resolveExport(imp.file, imp.name, depth + 1) : null;
  };
  const resolveExport = (file: string, name: string, depth = 0): { u: Unit; name: string } | null => {
    const u = inside(file) ? load(file) : null;
    if (!u || depth > 20) return null;
    const e = u.exports.get(name);
    if (!e) return null;
    return 'local' in e ? resolveName(file, e.local, depth + 1) : resolveExport(e.file, e.name, depth + 1);
  };
  const include = (at: { u: Unit; name: string }) => {
    const key = `${at.u.file}#${at.name}`;
    if (done.has(key) || skip.includes(key)) return;
    done.add(key);
    for (const ref of entries(at.u, key, at.u.decls.get(at.name)!, out)) {
      const r = resolveName(at.u.file, ref);
      if (r) include(r);
    }
  };
  for (const file of entryFiles) {
    const u = load(file)!;
    for (const name of u.exports.keys()) {
      const r = resolveExport(file, name);
      // What each entry exports, and where it is declared (a move to another file is a change).
      out[`${file}#export:${name}`] = r ? `${r.u.file}#${r.name}` : '?';
      if (r) include(r);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** What changed from `before` to `now`: entries added (a minor bump), and removed or changed (a major one). */
export function compare(before: Fingerprint, now: Fingerprint): { added: string[]; removed: string[]; changed: string[] } {
  return {
    added: Object.keys(now).filter((k) => !(k in before)),
    removed: Object.keys(before).filter((k) => !(k in now)),
    changed: Object.keys(now).filter((k) => k in before && before[k] !== now[k]),
  };
}

export const webPath = (p: string) => join(WEB, p);

/**
 * Checks an API against its snapshot ({ version, entries }, a JSON file under web/): unchanged, or changed with
 * the bump it needs already made (then the snapshot is to be refreshed on purpose); else says which bump is
 * needed. KLATCHLY_UPDATE_CONTRACTS=1 (npm run contracts) writes the snapshot instead. Returns the problem, or null.
 */
export function checkSnapshot(what: string, snapshot: string, version: string, bumpWhere: string, now: Fingerprint): string | null {
  const file = join(WEB, snapshot);
  if (process.env.KLATCHLY_UPDATE_CONTRACTS === '1') {
    writeFileSync(file, `${JSON.stringify({ version, entries: now }, null, 1)}\n`);
    return null;
  }
  if (!existsSync(file)) return `${what}: no snapshot (${snapshot}); record it with KLATCHLY_UPDATE_CONTRACTS=1 npm test (npm run contracts)`;
  const before = JSON.parse(readFileSync(file, 'utf8')) as { version: string; entries: Fingerprint };
  const d = compare(before.entries, now);
  if (!d.added.length && !d.removed.length && !d.changed.length) return null;
  const need = d.removed.length || d.changed.length ? 'major' : 'minor';
  const list = (label: string, keys: string[]) => (keys.length ? `\n  ${label}: ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ` (+${keys.length - 12})` : ''}` : '');
  const changes = `${what} changed since ${before.version}:${list('added', d.added)}${list('removed', d.removed)}${list('changed', d.changed)}`;
  const made = bumpOf(before.version, version);
  if (made === 'major' || (made === 'minor' && need === 'minor'))
    return `${changes}\n${version} is the right bump: refresh the snapshot on purpose with KLATCHLY_UPDATE_CONTRACTS=1 npm test (npm run contracts).`;
  return `${changes}\nThat needs a ${need} bump (${need === 'major' ? 'something removed or changed' : 'only additions'}): ${before.version} -> ${bumped(before.version, need)} in ${bumpWhere}, then KLATCHLY_UPDATE_CONTRACTS=1 npm test (npm run contracts).`;
}
