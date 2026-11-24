import type { Chat, Message, Page } from '../server/connector.js';
import { connector, definePackage, Registry, type ConnectorModule, type ServerPackage } from '../server/registry.js';

// A tiny connector for the core's own tests (the core needs one to start, and its chat routes ask one): chats
// and messages in memory, every call recorded as "method chatID…". Not the beeper package (boundary.test.ts:
// the core's tests import nothing of ext/).

export interface FakeSource {
  module: ConnectorModule;
  pkg: ServerPackage;
  calls: string[];
  chats: Map<string, Chat>;
  messages: Map<string, Message[]>;
  /** The media this source names: ?m=<id>, bytes from `media`. */
  media: Map<string, Buffer>;
}

const page = <T>(items: T[]): Page<T> => ({ items, hasMore: false, oldestCursor: null, newestCursor: null });

export function fakeSource(over: Partial<ConnectorModule> = {}, id = 'fake'): FakeSource {
  const calls: string[] = [];
  const chats = new Map<string, Chat>();
  const messages = new Map<string, Message[]>();
  const media = new Map<string, Buffer>();
  const notFound = () => Object.assign(new Error('not found'), { name: 'FakeNotFound' });
  const module = connector({
    id,
    capabilities: { actorSend: true, flags: ['isPinned', 'isMuted'] },
    failure: (e) => (e instanceof Error && e.name === 'FakeNotFound' ? { status: 404 } : undefined),
    accounts: async () => [{ accountID: id, network: 'Fake' }],
    listChats: async () => page([...chats.values()]),
    searchChats: async () => page([...chats.values()]),
    searchMessages: async () => page([]),
    async chat(chatID) {
      calls.push(`chat ${chatID}`);
      const c = chats.get(chatID);
      if (!c) throw notFound();
      return c;
    },
    async messages(chatID) {
      calls.push(`messages ${chatID}`);
      return page(messages.get(chatID) ?? []);
    },
    async message(chatID, messageID) {
      calls.push(`message ${chatID} ${messageID}`);
      const m = messages.get(chatID)?.find((x) => x.id === messageID);
      if (!m) throw notFound();
      return m;
    },
    async send(chatID, m) {
      calls.push(`send ${chatID} ${JSON.stringify(m)}`);
      return { chatID, pendingMessageID: `p${calls.length}` };
    },
    async markRead(chatID) {
      calls.push(`read ${chatID}`);
    },
    unreadChats: async () => [...chats.values()],
    media: {
      params: ['m'],
      parse: (q) => (q.m && /^[a-z0-9]{1,16}$/.test(q.m) ? { kind: 'fake', key: `fake|${q.m}`, original: `/api/media/m.jpg?m=${q.m}` } : null),
      async fetch(ref) {
        const b = media.get(ref.key.slice(5));
        return b ? { status: 200, headers: { 'content-length': String(b.length) }, body: new Blob([b]).stream() } : { status: 404, headers: {}, body: null };
      },
    },
    ...over,
  });
  // First in the declared order (beeper: 10). Without `owns` in `over`: the legacy catch-all (connector.ts).
  return { module, pkg: testPackage({ id, order: 10, modules: [module] }), calls, chats, messages, media };
}

/** A registry with the fake connector (and these packages): what the core's chat routes ask from then on. */
export function withFake(src: FakeSource = fakeSource(), packages: readonly ServerPackage[] = [], env?: Record<string, string>): Registry {
  return new Registry([src.pkg, ...packages], env);
}

/** A made-up package for the core's tests: version 1.0.0, for this extension API, unless the test says otherwise. */
export const testPackage = (p: Omit<ServerPackage, 'version' | 'klatchly'> & Partial<Pick<ServerPackage, 'version' | 'klatchly'>>): ServerPackage =>
  definePackage({ version: '1.0.0', klatchly: '^2.0', ...p });
