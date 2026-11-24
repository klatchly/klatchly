import { ConnectorError, upstreamSignal, type Account, type Chat, type ConnectorShape, type Message, type Page } from '#core/sdk.js';
import { api } from './upstream.js';
import { forgetMutedByMove, lowPriorityPlan, mutedByMove, setMutedByMove } from './lowpri.js';
import { enrichMessage, enrichPage } from './delivery.js';
import { localChat, localChatMap, localPage, readUpstream } from './localread.js';
import { noteAccountList, noteChatAccounts } from './accounts.js';
import { dropScan } from './inbox.js';

// The chats and messages of the Desktop API, one upstream call per method (moved from the core's relay, which
// keeps the routes, their validation and limits): what the core asks gets exactly the call it made before.

const enc = encodeURIComponent;

type UpstreamMessage = { id?: string; isSender?: boolean; isDeleted?: boolean; attachments?: unknown[] | null };

/** Edit/delete are only relayed for our own, non-deleted messages (checked upstream first). */
async function ownMessage(id: string, mid: string): Promise<UpstreamMessage | null> {
  const m = (await api().get(`/v1/chats/${enc(id)}/messages/${enc(mid)}`)) as UpstreamMessage;
  return m && m.isSender === true && !m.isDeleted ? m : null;
}

const forbidden = () => new ConnectorError(409, 'forbidden_message');

// Reads made for a browser stop when every browser waiting on them has gone (the core's upstreamSignal), instead
// of running to the 30 s timeout and piling up under load. Writes never take it: a send must not be cut halfway.
const reading = () => {
  const signal = upstreamSignal();
  return signal ? { signal } : {};
};

// The accounts it lists, and those its chats are on, are its own (accounts.ts: the connector's ownsAccount).
function learnPage<P extends { items?: Chat[] }>(p: P): P {
  noteChatAccounts(p?.items);
  return p;
}
function learnChat(c: Chat): Chat {
  if (c) noteChatAccounts([c]);
  return c;
}

export const desktop = {
  async accounts() {
    const list = (await api().accounts.list()) as unknown as Account[];
    if (Array.isArray(list)) noteAccountList(list.map((a) => a?.accountID));
    return list;
  },

  // Chats leave with their unread counts as Klatchly shows them (localread.ts: what was read discreetly is not unread).
  listChats: async (query) => localPage(learnPage((await api().get('/v1/chats', { query, ...reading() })) as Page<Chat>)),

  searchChats: async (query) => localPage(learnPage((await api().get('/v1/chats/search', { query, ...reading() })) as Page<Chat>)),

  async searchMessages(query) {
    const r = (await api().get('/v1/messages/search', { query, ...reading() })) as Page<Message> & { chats?: Record<string, Chat> };
    if (r?.chats && typeof r.chats === 'object') noteChatAccounts(Object.values(r.chats));
    return localChatMap(r);
  },

  chat: async (id, maxParticipantCount) => localChat(learnChat((await api().chats.retrieve(id, { maxParticipantCount }, reading())) as unknown as Chat)),

  messages: async (id, query) => enrichPage((await api().get(`/v1/chats/${enc(id)}/messages`, { query, ...reading() })) as Page<Message>),

  message: async (id, mid) => enrichMessage((await api().get(`/v1/chats/${enc(id)}/messages/${enc(mid)}`, reading())) as Message),

  async send(id, m) {
    const res = await api().messages.send(id, {
      ...(m.text ? { text: m.text } : {}),
      ...(m.replyToMessageID ? { replyToMessageID: m.replyToMessageID } : {}),
      ...(m.attachment ? { attachment: m.attachment } : {}),
    });
    return { chatID: res.chatID, pendingMessageID: res.pendingMessageID };
  },

  async markRead(id, messageID) {
    await api().chats.markRead(id, messageID ? { messageID } : {});
    readUpstream(id);
  },

  async edit(id, mid, text) {
    const m = await ownMessage(id, mid);
    if (!m || m.attachments?.length) throw forbidden();
    await api().put(`/v1/chats/${enc(id)}/messages/${enc(mid)}`, { body: { text } });
  },

  async deleteMessage(id, mid, forEveryone) {
    if (!(await ownMessage(id, mid))) throw forbidden();
    // Not said: for everyone, as before the connectors.
    await api().delete(`/v1/chats/${enc(id)}/messages/${enc(mid)}`, { query: { forEveryone: forEveryone ?? true } });
  },

  async react(id, mid, reactionKey) {
    await api().post(`/v1/chats/${enc(id)}/messages/${enc(mid)}/reactions`, { body: { reactionKey } });
  },

  async unreact(id, mid, key) {
    await api().delete(`/v1/chats/${enc(id)}/messages/${enc(mid)}/reactions/${enc(key)}`);
  },

  async archive(id, archived) {
    await api().post(`/v1/chats/${enc(id)}/archive`, { body: { archived } });
    // The shared chat scan (inbox.ts) has the old flags.
    dropScan();
  },

  // Only pin, mute and low priority reach upstream (the core checks the keys). Low priority comes alone and also
  // mutes the chat (lowpri.ts): moving it back undoes only a mute it set.
  async update(id, patch) {
    if (typeof patch.isLowPriority === 'boolean') {
      const current = (await api().chats.retrieve(id, { maxParticipantCount: 0 })) as unknown as Chat;
      const plan = lowPriorityPlan(patch.isLowPriority, !!current.isMuted, mutedByMove(id));
      const chat = (await api().patch(`/v1/chats/${enc(id)}`, { body: plan.patch })) as Chat;
      setMutedByMove(id, plan.mutedByMove);
      dropScan();
      return { chat, applied: plan.patch };
    }
    const chat = (await api().patch(`/v1/chats/${enc(id)}`, { body: patch })) as Chat;
    dropScan();
    if (typeof patch.isMuted === 'boolean') forgetMutedByMove(id);
    return { chat, applied: patch };
  },
} satisfies Partial<ConnectorShape>;
