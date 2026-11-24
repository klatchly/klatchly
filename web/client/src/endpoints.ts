import type { Account, Chat, Contact, Message, NewChatCaps, Page, Preview, UploadResult } from './types';
import type { ExtensionsReply } from '../../server/extension';
import type { QuietRule, QuietRules } from '../../server/quiethours';

/** One messaging account and its discreet reading (GET /api/reading, server/reading.ts ReadingAccount). */
export interface ReadingAccount {
  accountID: string;
  network?: string;
  /** The account's own name on its network. */
  name?: string;
  source: string;
  discreet: boolean;
  /** What its connector can do; null: nothing known, never discreet. */
  support: { discreet: boolean; send: boolean; available: boolean; replyMayTell: boolean; replyTells?: boolean; note?: Readonly<Record<string, string>> } | null;
}
/** The accounts, and the chats with their own choice (chat id → discreet; absent: their account's). */
export type ReadingReply = { accounts: ReadingAccount[]; chats?: Record<string, boolean> };

/** GET /api/quiet (server/quiet.ts QuietReply): the accounts for Settings, and every quiet-hours rule. */
export type QuietReply = QuietRules & {
  list: { accountID: string; network?: string; name?: string; source: string }[];
};
import { learnNames, setNameFetcher } from './names';
import { connectorMediaQuery, isConnectorMedia } from './connectors';

// The chat's "Media, links and files" page (server/chatmedia.ts) and forwarding (server/forward.ts).
export type MediaTab = 'media' | 'files' | 'links';
export interface LinkItem {
  url: string;
  domain: string;
  title?: string;
  summary?: string;
  img?: string;
}
export type MediaMessage = Pick<Message, 'id' | 'chatID' | 'senderID' | 'senderName' | 'isSender' | 'timestamp' | 'sortKey' | 'text' | 'attachments'> & { urls?: LinkItem[] };
export interface MediaPage {
  items: MediaMessage[];
  hasMore: boolean;
  cursor: string | null;
}
export interface ForwardSource {
  chatID: string;
  messageID: string;
  attachment?: number;
}
export interface ForwardResult {
  chatID: string;
  ok: boolean;
  sent: number;
  error?: string;
}

// The JSON call, its error, qs and the sign-in calls: api.ts (also in the public boot entry, and the packages' through
// sdk.ts); re-exported here, so the app's modules import all of the API from this file.
export { HttpError, qs, request, setSignedOutHandler } from './api';
import { authApi, HttpError, notifySignedOut, qs, request } from './api';

const enc = encodeURIComponent;

export interface SendBody {
  text?: string;
  replyToMessageID?: string;
  attachment?: { uploadID: string; fileName?: string; mimeType?: string; type?: 'file' | 'voice-note' | 'audio'; duration?: number };
}

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * Streams a file to /api/upload (XHR for upload progress), into the uploads of the connector of `chatID`: its
 * sends take only those (no chat: the one connector that takes uploads without one, server/upload.ts).
 */
export function upload(file: File, onProgress: (fraction: number) => void, chatID?: string): { promise: Promise<UploadResult>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadResult>((resolve, reject) => {
    xhr.open('POST', `/api/upload${chatID ? `?chatID=${encodeURIComponent(chatID)}` : ''}`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Name', enc(file.name.slice(0, 255)));
    if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type)) xhr.setRequestHeader('X-Upload-Type', file.type.toLowerCase());
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      // A redirect (session gone) is followed by XHR and lands on the SPA.
      if (!/\/api\/upload(\?|$)/.test(xhr.responseURL)) {
        notifySignedOut();
        reject(new HttpError(302));
        return;
      }
      const r = xhr.response as UploadResult | null;
      if (xhr.status === 200 && r && typeof r.uploadID === 'string') resolve(r);
      else reject(new HttpError(xhr.status || 0));
    };
    xhr.onerror = () => reject(new HttpError(0));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
/** Repeated accountIDs params (network filter), appended to a query string built by qs(). */
const accountQS = (ids?: readonly string[]) => (ids?.length ? ids.map((a) => `&accountIDs=${encodeURIComponent(a)}`).join('') : '');

export const api = {
  ...authApi,
  logout: () => request<{ ok: true }>('POST', '/auth/logout'),
  /** The chat list; `accountIDs`: only those accounts' chats (the network filter, applied by the server). */
  chats: (cursor?: string, accountIDs?: readonly string[]) =>
    request<Page<Chat>>('GET', `/chats${qs({ cursor, direction: cursor ? 'before' : undefined, limit: 50 })}${accountQS(accountIDs)}`),
  chat: (id: string, allParticipants?: boolean) => request<Chat>('GET', `/chats/${enc(id)}${allParticipants ? '?participants=all' : ''}`),
  accounts: () => request<Account[]>('GET', '/accounts'),
  searchChats: (query: string, accountIDs?: string[]) =>
    request<Page<Chat>>('GET', `/chats/search${qs({ query, limit: 20 })}${accountQS(accountIDs)}`),
  archivedChats: (cursor?: string, accountIDs?: readonly string[]) =>
    request<Page<Chat>>('GET', `/chats/search${qs({ inbox: 'archive', cursor, direction: cursor ? 'before' : undefined, limit: 50 })}${accountQS(accountIDs)}`),
  lowPriorityChats: (cursor?: string, accountIDs?: readonly string[]) =>
    request<Page<Chat>>('GET', `/chats/search${qs({ inbox: 'low-priority', cursor, direction: cursor ? 'before' : undefined, limit: 50 })}${accountQS(accountIDs)}`),
  searchMessages: (query: string, cursor?: string, accountIDs?: string[]) =>
    request<Page<Message> & { chats: Record<string, Chat> }>(
      'GET',
      `/messages/search${qs({ query, cursor, direction: cursor ? 'before' : undefined })}${accountQS(accountIDs)}`,
    ),
  archive: (id: string, archived: boolean) => request<{ ok: true }>('POST', `/chats/${enc(id)}/archive`, { archived }),
  patchChat: (id: string, patch: { isPinned?: boolean; isMuted?: boolean } | { isLowPriority: boolean }) => request<Chat>('PATCH', `/chats/${enc(id)}`, patch),
  messages: (id: string, cursor?: string) =>
    request<Page<Message>>('GET', `/chats/${enc(id)}/messages${qs({ cursor, direction: cursor ? 'before' : undefined })}`).then((p) => {
      learnNames(p.items);
      return p;
    }),
  send: (id: string, body: SendBody) =>
    request<{ chatID: string; pendingMessageID: string }>('POST', `/chats/${enc(id)}/messages`, body),
  message: (id: string, mid: string) => request<Message>('GET', `/chats/${enc(id)}/messages/${enc(mid)}`),
  react: (id: string, mid: string, reactionKey: string) =>
    request<{ ok: true }>('POST', `/chats/${enc(id)}/messages/${enc(mid)}/reactions`, { reactionKey }),
  unreact: (id: string, mid: string, reactionKey: string) =>
    request<{ ok: true }>('DELETE', `/chats/${enc(id)}/messages/${enc(mid)}/reactions/${enc(reactionKey)}`),
  edit: (id: string, mid: string, text: string) => request<{ ok: true }>('PUT', `/chats/${enc(id)}/messages/${enc(mid)}`, { text }),
  remove: (id: string, mid: string, forEveryone: boolean) =>
    request<{ ok: true }>('DELETE', `/chats/${enc(id)}/messages/${enc(mid)}${qs({ forEveryone: String(forEveryone) })}`),
  pushKey: () => request<{ publicKey: string }>('GET', '/push/key'),
  pushSubscribe: (sub: PushSubscriptionJSON & { lang: string; declarative: true }) => request<{ ok: true }>('POST', '/push/subscribe', sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>('POST', '/push/unsubscribe', { endpoint }),
  pushTest: () => request<{ sent: number; failed: number }>('POST', '/push/test'),
  badge: () => request<{ badge: number }>('GET', '/notify/badge'),
  preview: (url: string, lang: string) => request<Preview>('GET', `/preview${qs({ url, lang })}`),
  markRead: (id: string) => request<{ ok: true }>('POST', `/chats/${enc(id)}/read`, {}),
  /** The explicit "Mark as read": tells the network even when the chat reads discreetly (server/reading.ts). */
  sendReadReceipt: (id: string) => request<{ ok: true; receipt: boolean }>('POST', `/chats/${enc(id)}/read`, { receipt: true }),
  reading: () => request<ReadingReply>('GET', '/reading'),
  setDiscreet: (accountID: string, discreet: boolean) => request<ReadingReply>('PUT', `/reading/${enc(accountID)}`, { discreet }),
  /** A chat's own choice; null: back to its account's. */
  setChatDiscreet: (chatID: string, discreet: boolean | null) => request<ReadingReply>('PUT', `/reading/chat/${enc(chatID)}`, { discreet }),
  resetChatDiscreet: () => request<ReadingReply>('DELETE', '/reading/chats'),
  quiet: () => request<QuietReply>('GET', '/quiet'),
  setAccountQuiet: (accountID: string, rule: QuietRule | null) => request<QuietReply>('PUT', `/quiet/account/${enc(accountID)}`, { rule }),
  setChatQuiet: (chatID: string, rule: QuietRule | false | null) => request<QuietReply>('PUT', `/quiet/chat/${enc(chatID)}`, { rule }),
  resetChatQuiet: () => request<QuietReply>('DELETE', '/quiet/chats'),
  releaseQuiet: () => request<QuietReply>('POST', '/quiet/release'),
  extensions: () => request<ExtensionsReply>('GET', '/extensions'),
  newChatCaps: (accountID: string) => request<NewChatCaps>('GET', `/accounts/${enc(accountID)}/new-chat`),
  contacts: (accountID: string, query: string) => request<{ items: Contact[] }>('GET', `/accounts/${enc(accountID)}/contacts${qs({ query })}`),
  contactList: (accountID: string, cursor?: string) =>
    request<{ items: Contact[]; hasMore: boolean; oldestCursor: string | null }>('GET', `/accounts/${enc(accountID)}/contacts/list${qs({ cursor })}`),
  startChat: (accountID: string, user: Partial<Pick<Contact, 'id' | 'username' | 'phoneNumber' | 'email' | 'fullName'>>) =>
    request<Chat>('POST', '/chats/start', { accountID, user }),
  createChat: (body: { accountID: string; type: 'group'; participantIDs: string[]; title?: string }) => request<Chat>('POST', '/chats', body),
  chatMedia: (id: string, tab: MediaTab, cursor?: string) => request<MediaPage>('GET', `/chats/${enc(id)}/media${qs({ tab, cursor })}`),
  forward: (from: ForwardSource[], to: string[]) => request<{ results: ForwardResult[] }>('POST', '/forward', { from, to }),
  readAllLowPriority: () => request<{ total: number; marked: number; failed: number; complete: boolean }>('POST', '/inbox/low-priority/read-all', {}),
};

// Document types the relay may be told (server/media.ts HINT_TYPES has the same ones and decides).
const DOC_TYPES = new Set([
  'application/pdf', 'text/plain', 'text/csv', 'application/rtf', 'application/zip', 'application/x-7z-compressed', 'application/vnd.rar',
  'application/x-rar-compressed', 'application/gzip', 'application/x-tar', 'application/msword', 'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
]);

/**
 * Relay URL for a media reference, or undefined when it cannot be served. `name` (attachments only) becomes
 * the file name of downloads (Content-Disposition). A connector's own media paths (connectors.ts) are used as
 * they are: their server routes name the file themselves. Its other references go through /api/media with the
 * parameters it names (ConnectorTraits.mediaQuery); a reference no connector of the build names: none.
 */
export function mediaUrl(u: string | undefined, mime?: string, name?: string): string | undefined {
  if (u && isConnectorMedia(u)) return u;
  const q = u ? connectorMediaQuery(u) : undefined;
  if (!q) return undefined;
  const type = mime?.split(';')[0]?.trim().toLowerCase();
  const media = type && /^(image|video|audio)\/[a-z0-9.+-]+$/.test(type) ? type : undefined;
  const doc = type && DOC_TYPES.has(type) ? type : undefined;
  // A static-looking file name keeps CrowdSec from taking a burst of avatars for a crawler (server/app.ts MEDIA_FILE).
  const file = !type || media?.startsWith('image/') ? 'm.jpg' : media?.startsWith('video/') ? 'm.mp4' : media ? 'm.mp3' : 'm.bin';
  const hint = media ?? doc;
  const n = name?.normalize('NFC').trim().slice(0, 200);
  return `/api/media/${file}?${q}${hint ? `&type=${enc(hint)}` : ''}${n ? `&name=${enc(n)}` : ''}`;
}

/** Relay URL of a message attachment (the same for the bubble, the viewer and saving: one cache entry). */
export const attachmentUrl = (a: { srcURL?: string; mimeType?: string; fileName?: string }) => mediaUrl(a.srcURL, a.mimeType, a.fileName);

setNameFetcher((id) => api.messages(id));
