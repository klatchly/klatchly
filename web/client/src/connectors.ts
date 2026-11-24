// What the connectors' chats and media are like on the client (the data part of extension.ts ConnectorUI), for
// this build, set once by registry.ts as it loads: who owns a chat, and the media a connector names as its own.
// No connector is privileged: a chat that no connector of the build claims gets none of these behaviours (no
// low-priority inbox, no cached delivery ticks, no media). No imports, so pure modules (thumbs.ts, receipts.ts) can
// ask it and stay testable alone.

/** The data part of a connector's UI side (extension.ts ConnectorUI extends it). */
export interface ConnectorTraits {
  id: string;
  name: string;
  /** Network names (as chats and accounts carry them, letters only, lower case) shown with its name and mark. */
  networks?: readonly string[];
  /** Whether a chat is its own (the server's `owns`); absent: none is told apart. */
  owns?: (chatID: string) => boolean;
  /** Its chats can go to the low-priority inbox (default true, for a connector that claims chats with `owns`). */
  lowPriority?: boolean;
  /** Its chats take no files (forwarded files are refused: the server's connector has no uploads). */
  textOnly?: boolean;
  /**
   * Its messages carry their delivery positions whole: a new copy without them has none (by default, for a connector
   * that claims chats, a cached copy's delivered ticks are kept, as they come from the server's inference only).
   */
  fullDelivery?: boolean;
  /** Media URLs its entries give as they are (paths of its own server routes), used without the core's relay. */
  mediaURL?: RegExp;
  /** The /api/thumb parameters of one of its media URLs (path and query apart), or undefined: no thumbnail. */
  thumb?: (path: string, query: URLSearchParams) => string | undefined;
  /**
   * The /api/media parameters (an encoded query string, its server half's media.params) naming one of its media
   * references as its entries carry them, or undefined: not its own. The core adds the path, the type hint and the
   * download name. (1.25.0)
   */
  mediaQuery?: (url: string) => string | undefined;
  /** One of its chats whose capabilities list no formatting still displays Markdown. Absent: it displays none. (1.25.0) */
  displaysMarkdown?: (chat: { accountID?: string; network?: string }) => boolean;
}

// The modules as the build has them (extension.ts ConnectorUI): their mark comes along, opaque here.
type Listed = ConnectorTraits & { icon?: unknown };
let list: readonly Listed[] = [];

/** Set by registry.ts (the packages of the build); tests set their own. */
export function useConnectorTraits(l: readonly Listed[]): void {
  list = l;
}

/** The connector that shows this network (its key: letters only, lower case), with its mark, if any. */
export const networkConnector = (key: string): Listed | undefined => list.find((k) => k.networks?.includes(key));

/** The connector that tells this chat as its own, if any. */
export const chatConnector = (chatID: string | undefined): ConnectorTraits | undefined => (chatID ? list.find((k) => k.owns?.(chatID)) : undefined);

/** Whether a media URL is one a connector gives as its own path (served as it is). */
export const isConnectorMedia = (url: string): boolean => list.some((k) => !!k.mediaURL?.test(url));

/** The /api/media parameters of a connector's media reference (ConnectorTraits.mediaQuery), or undefined: none's. */
export function connectorMediaQuery(url: string): string | undefined {
  for (const k of list) {
    const q = k.mediaQuery?.(url);
    if (q) return q;
  }
  return undefined;
}

/** Whether a reference is one of a connector's media (its own path, or one its relay names). */
export const isConnectorMediaRef = (url: string | undefined): url is string => !!url && (isConnectorMedia(url) || !!connectorMediaQuery(url));

/**
 * Whether there is a low-priority inbox: a connector that claims chats and keeps one (ConnectorTraits.lowPriority),
 * among those on (`on`: the ids of the connectors the server has on, registry.ts useLowPriorityShown) or, before the
 * server has said, in the build.
 */
export const lowPriorityShown = (on?: ReadonlySet<string>): boolean =>
  list.some((k) => !!k.owns && k.lowPriority !== false && (!on || on.has(k.id)));

/** The thumbnail parameters of a connector's own media URL, or undefined. */
export function connectorThumb(path: string, query: URLSearchParams): string | undefined {
  for (const k of list) {
    const q = k.thumb?.(path, query);
    if (q) return q;
  }
  return undefined;
}
