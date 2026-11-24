import { ConnectorError, type Failure } from './connector.js';
import type { ConnectorModule } from './registry.js';

// The connectors of the running build (the registry hands them over when it is built, see registry.ts) and which
// one owns a chat or an account: the one that claims it (ConnectorShape.owns / ownsAccount; ids never overlap). No
// connector is privileged: the unscoped routes find theirs by what each declares (media.ts and thumbs: each one's
// media.parse; upload.ts: the one plain uploader; readall.ts: every low-priority reader). A chat or account claimed
// by a connector of the build that is off belongs to nobody (404).
//
// Legacy (before API 1.25): a connector that declares no `owns` (at most one per build, deprecated) still gets the
// chat ids no other connector claims, and one without `ownsAccount` the unclaimed account ids, for chat and account
// routing only. Nothing else goes to it for lacking them.

let current: () => readonly ConnectorModule[] = () => [];
let built: () => readonly ConnectorModule[] = () => [];

/** Set by the registry: its connectors that are on (a package that fails goes away from here too), and all of them. */
export function useConnectors(on: () => readonly ConnectorModule[], all: () => readonly ConnectorModule[] = on): void {
  current = on;
  built = all;
}

export const connectors = (): readonly ConnectorModule[] => current();

function claim(claims: (k: ConnectorModule) => boolean, legacy: (k: ConnectorModule) => boolean): ConnectorModule | undefined {
  const by = built().find(claims);
  if (by) return current().includes(by) ? by : undefined;
  return current().find(legacy);
}

export const connectorFor = (chatID: string): ConnectorModule | undefined => claim((k) => !!k.owns?.(chatID), (k) => !k.owns);

// An account no connector claims: a legacy connector's (no ownsAccount), or one that has not learned its accounts yet
// (accountsPending: e.g. Beeper on its first start, before beeper-server has listed them).
export const connectorForAccount = (accountID: string): ConnectorModule | undefined =>
  claim((k) => !!k.ownsAccount?.(accountID), (k) => !k.ownsAccount || !!k.accountsPending?.());

/**
 * The connector that takes an upload without a chat: the one connector on with a plain `upload` (uploadFor is bound
 * to a chat). Undefined when none has one, or when several do (the browser must then name the chat: plainUploaders).
 */
export const plainUploaders = (): ConnectorModule[] => current().filter((k) => !!k.upload);
export const plainUploader = (): ConnectorModule | undefined => {
  const list = plainUploaders();
  return list.length === 1 ? list[0] : undefined;
};

/** The connectors on that mark their whole low-priority inbox read (readAllLowPriority, in its receipts or not). */
export const lowPriorityReaders = (): ConnectorModule[] =>
  current().filter((k) => !!(k.readAllLowPriority || k.receipts?.readAllLowPriority || k.receipts?.readAllLowPriorityByChat));

// Errors thrown by a connector's call made for a package (the chat reader, the actor), so that the package's
// answer (sdk fail) asks that connector only.
const origin = new WeakMap<object, ConnectorModule>();

/** Runs a connector's call, remembering which connector an error came from. */
export async function from<T>(source: ConnectorModule, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e && typeof e === 'object') origin.set(e, source);
    throw e;
  }
}

/**
 * How an error of a connector's call is answered: its own choice (ConnectorError), the mapping of the connector
 * that threw it (`source`, or the one `from` saw), else 502. Never another connector's guess.
 */
export function failureOf(e: unknown, source?: ConnectorModule): Failure {
  if (e instanceof ConnectorError) return { status: e.status, code: e.code };
  const k = source ?? (e && typeof e === 'object' ? origin.get(e) : undefined);
  return k?.failure?.(e) ?? { status: 502 };
}
