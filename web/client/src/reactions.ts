// Reaction logic shared by the bubble pills, the menu/picker and the chat list. Pure functions (unit-tested
// in test/reactions.test.ts) plus the per-device "recently used" list.
// Structural copies of the types.ts shapes used here (this file is also compiled by the Node unit tests).
import { isConnectorMediaRef } from './connectors.js';

export interface Reaction {
  id: string;
  reactionKey: string;
  participantID: string;
  emoji?: boolean;
  imgURL?: string;
}
export interface ChatCapabilities {
  reactionCount?: number;
  allowedReactions?: string[];
  customEmojiReactions?: boolean;
  reaction?: number;
}

/** Double-click (desktop) / double-tap (touch) on a bubble toggles the default reaction. Set to false to disable. */
export const DOUBLE_TAP_REACTION = true;

/** Default quick reactions, in this order, after the user's recent ones. */
export const DEFAULTS = ['❤️', '😂', '😮', '😢', '👍', '🙏'];

/** Compare emoji ignoring the U+FE0F presentation selector (networks differ on it). */
export const normEmoji = (s: string) => s.replace(/️/g, '');
export const sameEmoji = (a: string, b: string) => normEmoji(a) === normEmoji(b);

/**
 * An image reaction's key or picture: one of a connector's media references (connectors.ts; e.g. a content URI its
 * relay serves). Anything else is never shown as a picture.
 */
export const isMediaKey = (s: string | undefined): s is string => isConnectorMediaRef(s);

export type ReactionKind = 'emoji' | 'image' | 'shortcode';

/** How to show a reaction: unicode emoji as text, image/custom ones as a picture, anything else as :code:. */
export function reactionView(r: { reactionKey: string; emoji?: boolean; imgURL?: string }): { kind: ReactionKind; text: string; img?: string } {
  const key = r.reactionKey;
  const img = isMediaKey(r.imgURL) ? r.imgURL : isMediaKey(key) ? key : undefined;
  if (img && (r.emoji === false || isMediaKey(key))) return { kind: 'image', text: '', img };
  if (r.emoji === true || (r.emoji !== false && looksLikeEmoji(key))) return { kind: 'emoji', text: key };
  const code = key.replace(/^:+|:+$/g, '').slice(0, 32) || '?';
  return { kind: 'shortcode', text: `:${code}:` };
}

/** Short strings made of pictographs / regional indicators / keycaps (no letters or digits alone). */
export function looksLikeEmoji(s: string): boolean {
  if (!s || s.length > 16) return false;
  return /^(?:[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}‍️⃣#*0-9])+$/u.test(s) && /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u.test(s);
}

/** Identity of a pill: image reactions by picture, emoji ignoring FE0F, other keys as-is. */
export function groupKey(r: { reactionKey: string; emoji?: boolean; imgURL?: string }): string {
  const v = reactionView(r);
  if (v.kind === 'image') return `img:${v.img}`;
  if (v.kind === 'emoji') return `e:${normEmoji(r.reactionKey)}`;
  return `k:${r.reactionKey}`;
}

export interface ReactionGroup {
  id: string;
  /** Key to send for "+1" / to remove (our own key when we reacted, otherwise the first one seen). */
  key: string;
  view: ReturnType<typeof reactionView>;
  count: number;
  mine: boolean;
  /** Participant IDs, ours first. */
  who: string[];
}

/** Pills for a message, in order of first appearance. */
export function groupReactions(reactions: Reaction[] | undefined, selfIDs: Set<string>): ReactionGroup[] {
  const out = new Map<string, ReactionGroup>();
  for (const r of reactions ?? []) {
    if (!r || typeof r.reactionKey !== 'string' || !r.reactionKey) continue;
    const id = groupKey(r);
    const self = selfIDs.has(r.participantID);
    let g = out.get(id);
    if (!g) out.set(id, (g = { id, key: r.reactionKey, view: reactionView(r), count: 0, mine: false, who: [] }));
    if (g.who.includes(r.participantID)) continue;
    g.count++;
    if (self) {
      g.mine = true;
      g.key = r.reactionKey;
      g.who.unshift(r.participantID);
    } else g.who.push(r.participantID);
  }
  return [...out.values()];
}

/** Undefined when the network accepts any key (no list published). */
export function allowedList(caps: ChatCapabilities | undefined): string[] | undefined {
  return caps?.allowedReactions?.length ? caps.allowedReactions : undefined;
}

/**
 * The exact key to send for `key` in this chat (the network's own spelling, e.g. with or without FE0F),
 * or undefined when the network would refuse it.
 */
export function sendableKey(key: string, caps: ChatCapabilities | undefined): string | undefined {
  const allowed = allowedList(caps);
  if (isMediaKey(key)) {
    // Custom/image reactions: chats without restrictions known (no capabilities) or networks that say they take them.
    const noCaps = !caps || Object.keys(caps).length === 0;
    return !allowed && (noCaps || caps?.customEmojiReactions) ? key : undefined;
  }
  if (!allowed) return key;
  return allowed.find((a) => sameEmoji(a, key));
}

export interface TogglePlan {
  /** Reactions after the change (optimistic state). */
  next: Reaction[];
  /** Our keys to remove first (the one toggled off, or the ones a single-reaction network replaces). */
  remove: string[];
  /** Key to add after the removals. */
  add?: string;
}

/**
 * Toggle `key` for us on a message. When reactionCount caps the reactions per user (1 on LINE, WhatsApp,
 * Telegram…), adding one beyond the cap removes our oldest ones first: an explicit DELETE before the POST,
 * so the result does not depend on how each bridge handles the overflow.
 */
export function planToggle(reactions: Reaction[] | undefined, key: string, selfIDs: Set<string>, selfID: string, reactionCount?: number): TogglePlan {
  const list = reactions ?? [];
  const probe = { reactionKey: key, emoji: !isMediaKey(key), imgURL: isMediaKey(key) ? key : undefined };
  const target = groupKey(probe);
  const mine = list.filter((r) => selfIDs.has(r.participantID));
  const existing = mine.find((r) => groupKey(r) === target);
  if (existing) {
    return { next: list.filter((r) => r !== existing), remove: [existing.reactionKey] };
  }
  const cap = reactionCount && reactionCount > 0 ? reactionCount : Infinity;
  // The API lists reactions newest first: keep the newest (cap - 1) of ours.
  const drop = mine.length >= cap ? mine.slice(cap - 1) : [];
  const added: Reaction = { id: `${selfID}${key}`, reactionKey: key, participantID: selfID, emoji: !isMediaKey(key), ...(isMediaKey(key) ? { imgURL: key } : {}) };
  return { next: [added, ...list.filter((r) => !drop.includes(r))], remove: drop.map((r) => r.reactionKey), add: key };
}

/** Six quick reactions: recent ones first, then the defaults, completed from the allowed list. */
export function quickReactions(allowed: string[] | undefined, recent: string[] = [], n = 6): string[] {
  const out: string[] = [];
  const push = (e: string) => {
    if (out.length >= n || isMediaKey(e)) return;
    const k = allowed ? allowed.find((a) => sameEmoji(a, e)) : e;
    if (k && !out.some((o) => sameEmoji(o, k))) out.push(k);
  };
  recent.forEach(push);
  DEFAULTS.forEach(push);
  allowed?.forEach(push);
  return out;
}

/** Reaction toggled by a double-click / double-tap: ❤️, or the first allowed default. */
export function defaultReaction(allowed: string[] | undefined): string | undefined {
  return quickReactions(allowed, [], DEFAULTS.length).find((e) => DEFAULTS.some((d) => sameEmoji(d, e))) ?? allowed?.[0];
}

// Recently used reactions, per device (localStorage may be unavailable: private mode, blocked storage).
const RECENT_KEY = 'reactions.recent';
export function recentReactions(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(0, 24) : [];
  } catch {
    return [];
  }
}
export function rememberReaction(key: string): void {
  if (isMediaKey(key)) return;
  try {
    const next = [key, ...recentReactions().filter((k) => !sameEmoji(k, key))].slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // not persisted on this device
  }
}
