// Matrix rooms the Beeper account can join (shared by both halves: the server's join route validates with it, the
// client tells a room's matrix.to link apart with it). Pure, no import.
//
// Accepted: a room alias '#name:server', a room id '!opaque:server' (or '!opaque', the server-less ids of room
// version 12), or a matrix.to link to either ('https://matrix.to/#/<alias or id>[/<event>][?via=server…]', the
// scheme optional when pasted). Refused: anything else, user ids ('@…'), groups ('+…'), event ids ('$…'),
// whitespace or control characters, more than 10 'via' servers, an id over 255 bytes.

/** The account of Beeper's own Matrix rooms (its native rooms, not a bridge's chats). */
export const MATRIX_ACCOUNT = 'matrix';

export interface RoomTarget {
  /** The room alias or id, decoded ('#name:server', '!opaque:server'). */
  room: string;
  kind: 'alias' | 'id';
  /** Servers to join through (a matrix.to link's 'via'), valid server names, without repeats. */
  via: string[];
}

const MAX_INPUT = 2048;
const MAX_VIA = 10;
// A server name: a DNS name, an IPv4 address or a bracketed IPv6 one, an optional port.
const SERVER = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*)(?::[0-9]{1,5})?$/;
// An alias's local part: letters and digits of any script, and . _ = + ~ -.
const ALIAS = /^#([\p{L}\p{N}._=+~-]{1,200}):(.+)$/u;
// A room id's opaque part (the url-safe base64 of v12 ids included); its server is optional.
const ROOM_ID = /^!([A-Za-z0-9._=+/~-]{1,255})(?::(.+))?$/;
const MATRIX_TO = /^(?:https:\/\/)?matrix\.to\/#\/(.*)$/i;

const validServer = (s: string): boolean => s.length <= 255 && SERVER.test(s) && Number(/:(\d+)$/.exec(s)?.[1] ?? 1) <= 65535;
const bytes = (s: string): number => new TextEncoder().encode(s).length;

/** A plain alias or room id, checked; null otherwise. */
function roomOf(s: string): Pick<RoomTarget, 'room' | 'kind'> | null {
  if (bytes(s) > 255) return null;
  const a = ALIAS.exec(s);
  if (a) return validServer(a[2]!) ? { room: s, kind: 'alias' } : null;
  const r = ROOM_ID.exec(s);
  if (r) return r[2] === undefined || validServer(r[2]) ? { room: s, kind: 'id' } : null;
  return null;
}

/** What a user typed or a link points to, as a room to join; null for anything else. */
export function parseRoomTarget(input: unknown): RoomTarget | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_INPUT || /[\s\p{Cc}]/u.test(s)) return null;
  const link = MATRIX_TO.exec(s);
  if (!link) {
    const r = roomOf(s);
    return r && { ...r, via: [] };
  }
  const [path = '', query = ''] = link[1]!.split(/\?(.*)/s, 2);
  // The room is the first segment (an event id may follow), percent-encoded or not.
  let first: string;
  try {
    first = decodeURIComponent(path.split('/')[0]!);
  } catch {
    return null;
  }
  if (/[\s\p{Cc}]/u.test(first)) return null;
  const r = roomOf(first);
  if (!r) return null;
  const via: string[] = [];
  for (const [k, v] of new URLSearchParams(query)) {
    if (k !== 'via') continue;
    if (!validServer(v)) return null;
    if (!via.includes(v)) via.push(v);
  }
  return via.length > MAX_VIA ? null : { ...r, via };
}

/** Whether a link (an href) is a matrix.to link to a room: one the app can join or open itself. */
export const isRoomLink = (href: string): boolean => MATRIX_TO.test(href) && /^https:/i.test(href) && parseRoomTarget(href) !== null;
