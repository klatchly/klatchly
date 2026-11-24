import type { Attachment, ConnectorShape, Message, Upstream } from '#core/sdk.js';
import { upstreamToken, upstreamUrl } from './upstream.js';

// Beeper's media: Matrix content URIs (mxc://), relayed from beeper-server's /v1/assets/serve (moved from the
// core's media.ts, which keeps the relay's headers: type allowlist, disposition, sandbox).
//
// The upstream /v1/assets/serve also accepts file:// URLs (arbitrary file read inside beeper-server),
// so only strict Matrix content URIs are relayed: scheme://server-name/media-id, optionally followed by
// the single parameter that end-to-end encrypted media carry (?encryptedFileInfoJSON=<base64url JSON>).
// That JSON is decoded and checked field by field (Matrix EncryptedFile v2, or Beeper's floe v1); its inner url
// must be the same mxc:// URI.
// '!' appears in local bridges' cache paths (<server>/<account>/<!room>/<file>, see the client's toMxc).
const MEDIA_URL = /^(mxc|localmxc):\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?(\/[A-Za-z0-9._~=+!-]{1,255}){1,8}$/;
const ENC_PARAM = /^encryptedFileInfoJSON=([A-Za-z0-9_-]{16,4096}={0,2})$/;
const B64 = /^[A-Za-z0-9+/_-]{1,128}={0,2}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

// Beeper's own media encryption ("floe", v: com.beeper.floe.v1), seen from beeper-server 4.3.284 on new
// WhatsApp media (pictures, videos, GIFs): a header and a key, both base64, next to the inner url. No iv/hashes.
const FLOE_V = 'com.beeper.floe.v1';
const B64_LONG = /^[A-Za-z0-9+/_-]{1,512}={0,2}$/;

function validFloeInfo(j: Record<string, unknown>, base: string): boolean {
  if (!onlyKeys(j, ['v', 'url', 'floe_header', 'floe_key', 'mimetype'])) return false;
  if (j.v !== FLOE_V) return false;
  if (j.url !== undefined && j.url !== base) return false;
  if (typeof j.floe_header !== 'string' || !B64_LONG.test(j.floe_header)) return false;
  if (typeof j.floe_key !== 'string' || !B64.test(j.floe_key)) return false;
  if (j.mimetype !== undefined && (typeof j.mimetype !== 'string' || j.mimetype.length > 128)) return false;
  return true;
}

function validEncryptedInfo(b64: string, base: string): boolean {
  let j: unknown;
  try {
    j = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!isObj(j)) return false;
  if (j.v === FLOE_V) return validFloeInfo(j, base);
  // Matrix encrypted attachments (EncryptedFile, v: v2).
  if (!onlyKeys(j, ['v', 'url', 'iv', 'key', 'hashes', 'mimetype'])) return false;
  if (j.url !== undefined && j.url !== base) return false;
  if (typeof j.v !== 'string' || j.v.length > 8) return false;
  if (typeof j.iv !== 'string' || !B64.test(j.iv)) return false;
  if (j.mimetype !== undefined && (typeof j.mimetype !== 'string' || j.mimetype.length > 128)) return false;
  const h = j.hashes;
  if (!isObj(h) || !onlyKeys(h, ['sha256']) || typeof h.sha256 !== 'string' || !B64.test(h.sha256)) return false;
  const k = j.key;
  if (!isObj(k) || !onlyKeys(k, ['alg', 'ext', 'k', 'key_ops', 'kty'])) return false;
  if (k.alg !== 'A256CTR' || k.kty !== 'oct' || typeof k.k !== 'string' || !B64.test(k.k)) return false;
  if (k.ext !== undefined && typeof k.ext !== 'boolean') return false;
  if (k.key_ops !== undefined && (!Array.isArray(k.key_ops) || k.key_ops.some((x) => x !== 'encrypt' && x !== 'decrypt'))) return false;
  return true;
}

export function isAllowedMediaUrl(u: string | undefined): u is string {
  if (!u || u.length > 6144) return false;
  const q = u.indexOf('?');
  const base = q === -1 ? u : u.slice(0, q);
  if (base.length > 2048 || !MEDIA_URL.test(base)) return false;
  if (base.split('/').some((seg) => seg === '.' || seg === '..')) return false;
  if (q === -1) return true;
  const m = ENC_PARAM.exec(u.slice(q + 1));
  return !!m && validEncryptedInfo(m[1]!, base);
}

const serveUrl = (url: string) => `${upstreamUrl()}/v1/assets/serve?url=${encodeURIComponent(url)}`;

/** The connector's `media`: ?url=<mxc> (validated above), fetched from beeper-server with the token. */
export const mxcMedia: NonNullable<ConnectorShape['media']> = {
  params: ['url'],
  parse: (q) => (isAllowedMediaUrl(q.url) ? { kind: 'mxc', key: `mxc|${q.url}`, original: `/api/media/m.jpg?url=${encodeURIComponent(q.url)}` } : null),
  async fetch(ref, headers, signal) {
    const url = ref.key.slice('mxc|'.length);
    if (!ref.key.startsWith('mxc|') || !isAllowedMediaUrl(url)) return { status: 400, headers: {}, body: null };
    const up = await fetch(serveUrl(url), { headers: { ...headers, Authorization: `Bearer ${upstreamToken()}` }, redirect: 'manual', signal });
    const out: Record<string, string | undefined> = {};
    up.headers.forEach((v, k) => (out[k] = v));
    return { status: up.status, headers: out, body: up.body };
  },
};

/** The whole original of a validated mxc:// URI from beeper-server (forwarding). */
export function fetchMxc(url: string, signal: AbortSignal): Promise<Upstream> {
  return mxcMedia.fetch({ kind: 'mxc', key: `mxc|${url}`, original: '' }, {}, signal);
}

// beeper-server's media cache paths, as the client maps them (api.ts toMxc): file:///data/media/<server>/<rest>.
const CACHE_PATH = /^(?:file:\/\/)?\/data\/media\/([A-Za-z0-9.-]+)\/((?:[A-Za-z0-9._=!-]+\/){0,3}[A-Za-z0-9._=!-]+)$/;

/** The attachment's Matrix content URI, from its srcURL (encrypted media keep their key) or its ID; allowlisted. */
export function mxcOf(a: Pick<Attachment, 'id' | 'srcURL'>): string | undefined {
  for (const v of [a.srcURL, a.id]) {
    if (typeof v !== 'string') continue;
    const m = CACHE_PATH.exec(v);
    const u = m ? `mxc://${m[1]}/${m[2]}` : v;
    if (isAllowedMediaUrl(u)) return u;
  }
  return undefined;
}

/** The connector's `attachmentSource` (forwarding): its mxc:// original, when it has an allowlisted one. */
export function attachmentSource(_m: Message, a: Attachment): ((signal: AbortSignal) => Promise<Upstream>) | undefined {
  const url = mxcOf(a);
  return url ? (signal) => fetchMxc(url, signal) : undefined;
}

// Image / custom-emoji reactions use their Matrix content URI as the key (LINE: 92 characters): longer than the
// core's 64, so the connector says they are its own (ConnectorShape.longReactionKey; moved from the core's relay).
export const MXC_REACTION_KEY = /^mxc:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?\/[A-Za-z0-9._~=+-]{1,200}$/;

/** The connector's `longReactionKey`: a strict mxc:// key (removing one's own image reaction, re-using one). */
export const beeperReactionKey = (key: string): boolean => key.length <= 255 && MXC_REACTION_KEY.test(key);
