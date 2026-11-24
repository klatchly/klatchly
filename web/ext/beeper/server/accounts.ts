import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dataPath, log } from '#core/sdk.js';

// Which accounts are Beeper's (the connector's ownsAccount): those beeper-server has listed (/v1/accounts) or that
// its chats are on (every list, and the badge's whole chat list at each connection: SourceEvent 'ready'). Desktop
// API account ids follow no common pattern ('matrix', 'discordgo', 'slackgo.T-U', 'local-whatsapp_ba_…'), so
// ownership is what the source said, kept in the data volume (beeper-accounts.json): it holds across restarts and
// while beeper-server is down, so per-account settings (discreet reading, quiet hours, the network filter) keep
// resolving. Only grows (an account that went away claims nothing anyway: ids never overlap between sources),
// bounded, oldest out first.
//
// Until it knows them (first start: no file yet, and beeper-server has not listed its accounts), the connector says
// so (accountsPending): the core then gives it the account ids that no other connector claims, as the catch-all it
// used to be, so that a saved network filter or a per-account setting keeps reaching Beeper in that window. The
// first whole listing (/v1/accounts) ends it, and is saved (`listed`) even when it adds nothing.

const MAX_ACCOUNTS = 1000;
const SAVE_DELAY_MS = 2000;
const VALID = /^[^\u0000-\u001f\u007f\s]{1,200}$/;
const file = () => dataPath('beeper-accounts.json');

let known: Set<string> | undefined;
/** Whether the accounts are known: beeper-server has listed them whole (now, or before: the file says so). */
let complete = false;
let saveTimer: NodeJS.Timeout | undefined;
let dirty = false;

function store(): Set<string> {
  if (known) return known;
  known = new Set();
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as { accounts?: unknown; listed?: unknown };
    for (const id of Array.isArray(raw.accounts) ? raw.accounts : []) if (typeof id === 'string' && VALID.test(id)) known.add(id);
    trim(known);
    // Accounts learnt from chats only (no whole listing yet) are not all of them.
    complete = raw.listed === true;
  } catch {
    // first run: filled by the first listing
  }
  return known;
}

function trim(s: Set<string>): void {
  // Insertion order is age order.
  for (const id of s) {
    if (s.size <= MAX_ACCOUNTS) break;
    s.delete(id);
  }
}

/** Whether beeper-server has listed this account, or a chat on it (the connector's ownsAccount). */
export const knownAccount = (accountID: string): boolean => store().has(accountID);

/** Whether the accounts are not known yet (the connector's accountsPending): no file, no whole listing so far. */
export function accountsPending(): boolean {
  store();
  return !complete;
}

/** Learns the whole list beeper-server gives (/v1/accounts): the accounts are known from now on, the file written. */
export function noteAccountList(ids: Iterable<unknown>): void {
  store();
  if (!complete) {
    complete = true;
    dirty = true;
  }
  noteAccounts(ids);
}

/** Learns accounts from a listing or from chats (their accountID); saved a little later. */
export function noteAccounts(ids: Iterable<unknown>): void {
  const s = store();
  for (const id of ids) {
    if (typeof id !== 'string' || !VALID.test(id) || s.has(id)) continue;
    s.add(id);
    dirty = true;
  }
  if (!dirty) return;
  trim(s);
  if (saveTimer) return;
  saveTimer = setTimeout(flushAccounts, SAVE_DELAY_MS);
  saveTimer.unref();
}

/** The accounts of these chats (a page, a chat, the badge's whole list). */
export function noteChatAccounts(chats: readonly { accountID?: unknown }[] | undefined): void {
  if (chats?.length) noteAccounts(chats.map((c) => c?.accountID));
}

/** Writes the list now (also the debounced save; stop and tests call it directly). */
export function flushAccounts(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!known || !dirty) return;
  try {
    const tmp = `${file()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, listed: complete, accounts: [...known] }) + '\n', { mode: 0o600 });
    renameSync(tmp, file());
    dirty = false;
  } catch {
    log('beeper', 'accounts write failed');
  }
}

/** Forgets what was loaded (tests: read the file again, or start empty after removing it). */
export function resetAccountsForTests(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  known = undefined;
  complete = false;
  dirty = false;
}
