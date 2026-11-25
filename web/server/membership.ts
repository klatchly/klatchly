// Arrivals and departures in group chats, as beeper-server hands them over: plain messages with no type, "X joined
// the chat", "X was invited to the chat" (by the bridge's bot), "X left the chat"… (seen on Slack, WhatsApp and
// Matrix chats, 2026-11-25). Recognised here so the conversation can draw them as one discreet line, grouped or
// hidden (Settings → Reading, chatevents.ts), and push never notifies them. Pure, shared by the server and the client.

export type MembershipKind = 'joined' | 'left' | 'invited' | 'removed';
export interface Membership {
  who: string;
  kind: MembershipKind;
}

const RE = /^(.{1,120}?) (joined|left|was invited to|was removed from|was kicked from|was banned from) the (?:chat|group|channel|room)\.?$/;
const KINDS: Record<string, MembershipKind> = {
  joined: 'joined',
  left: 'left',
  'was invited to': 'invited',
  'was removed from': 'removed',
  'was kicked from': 'removed',
  'was banned from': 'removed',
};

/** The arrival or departure a message is, or null: any other message (one with a type, files, or rich text). */
export function membershipOf(m: { type?: unknown; text?: unknown; attachments?: unknown; isDeleted?: unknown }): Membership | null {
  // Only untyped messages: what people type comes as TEXT ("Dad left the group." is a message).
  if (m.type !== undefined || m.isDeleted === true) return null;
  if (Array.isArray(m.attachments) && m.attachments.length) return null;
  if (typeof m.text !== 'string' || m.text.length > 200 || m.text.includes('<') || m.text.includes('\n')) return null;
  const r = RE.exec(m.text.trim());
  return r ? { who: r[1]!, kind: KINDS[r[2]!]! } : null;
}

/** How the conversation draws them: grouped in one line (default), one line each, or not at all. */
export type MembershipMode = 'group' | 'each' | 'hide';
export const MEMBERSHIP_MODES: readonly MembershipMode[] = ['group', 'each', 'hide'];
export const DEFAULT_MEMBERSHIP_MODE: MembershipMode = 'group';

/**
 * A run of arrivals and departures summed up: per person their last event, an invitation dropped when the person
 * joined in the same run (the bridge sends both). In order of first appearance.
 */
export function summarize(events: readonly Membership[]): Membership[] {
  const last = new Map<string, MembershipKind>();
  for (const e of events) {
    const before = last.get(e.who);
    if (e.kind === 'invited' && before === 'joined') continue;
    last.delete(e.who);
    last.set(e.who, e.kind);
  }
  return [...last].map(([who, kind]) => ({ who, kind }));
}

/** GET /api/chat-events (chatevents.ts): the mode for all chats and the chats with their own. */
export interface ChatEventsReply {
  membership: MembershipMode;
  chats: Record<string, MembershipMode>;
}

interface RunMessage {
  id: string;
  timestamp: string;
  type?: string;
  text?: string;
  attachments?: unknown;
  isDeleted?: boolean;
}

/**
 * A conversation's messages with its arrivals and departures set apart, by mode: one entry per run of them (`group`:
 * a run ends at another message, a new day or the unread divider), one entry each (`each`: an invitation followed
 * by the person's arrival comes once), or none (`hide`); the other messages in runs between them. No mode (not a
 * group): all plain. `divider`: the message the unread divider goes on (the next shown one when it is hidden).
 */
export function membershipRuns<M extends RunMessage>(msgs: readonly M[], dividerID: string | undefined, mode: MembershipMode | undefined): { runs: (M[] | { members: M[] })[]; divider: string | undefined } {
  const out: (M[] | { members: M[] })[] = [];
  const day = (iso: string) => new Date(iso).toDateString();
  let divider = dividerID;
  let carry = false;
  let plain: M[] = [];
  let run: M[] = [];
  const flushPlain = () => {
    if (plain.length) out.push(plain);
    plain = [];
  };
  const flushRun = () => {
    if (!run.length) return;
    if (mode === 'group') out.push({ members: run });
    else
      run.forEach((m, i) => {
        const e = membershipOf(m)!;
        const next = run[i + 1] && membershipOf(run[i + 1]!);
        if (e.kind === 'invited' && next?.kind === 'joined' && next.who === e.who) {
          if (m.id === divider) divider = run[i + 1]!.id;
          return;
        }
        out.push({ members: [m] });
      });
    run = [];
  };
  for (const m of msgs) {
    const member = !!mode && !!membershipOf(m);
    if (member && mode === 'hide') {
      if (m.id === dividerID) carry = true;
      continue;
    }
    if (carry) {
      divider = m.id;
      carry = false;
    }
    if (member) {
      flushPlain();
      if (run.length && (m.id === divider || day(run[run.length - 1]!.timestamp) !== day(m.timestamp))) flushRun();
      run.push(m);
    } else {
      flushRun();
      plain.push(m);
    }
  }
  flushRun();
  flushPlain();
  // Every message from the divider on hidden: no divider row.
  return { runs: out, divider: carry ? undefined : divider };
}
