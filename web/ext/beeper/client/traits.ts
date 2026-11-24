import { isBeeperChatID } from '../package.js';

// What Beeper chats and media are like on the client (moved from the core, which assumes none of it): a
// low-priority inbox, delivery ticks inferred by the server half only (a cached copy keeps them), Matrix content
// URIs relayed by /api/media?url= (with their thumbnails), and native Matrix chats that display Markdown though
// their capabilities list no formatting. Plain data (tested without a browser, so it imports nothing of the client
// core: index.tsx checks it against ConnectorUI, which extends the sdk's ConnectorTraits).

// Avatars and our own just-sent attachments sometimes arrive as paths into beeper-server's media cache
// (file:///data/media/<server>/<id>, or for local bridges <server>/<account>/<!room>/<file>); the relay only
// accepts mxc:// so map them back (upstream serves the same path as mxc://<server>/<rest>).
const CACHE_PATH = /^(?:file:\/\/)?\/data\/media\/([A-Za-z0-9.-]+)\/((?:[A-Za-z0-9._=!-]+\/){0,3}[A-Za-z0-9._=!-]+)$/;
const MXC = /^(mxc|localmxc):\/\/[A-Za-z0-9.-]+(:\d+)?\/[^\s?#]+(\?encryptedFileInfoJSON=[A-Za-z0-9_=-]+)?$/;
// Its /api/media URLs (the core's mediaUrl: a static-looking file name, then ?url=<mxc>).
const RELAY_PATH = /^\/api\/media\/[a-z0-9]{1,16}\.[a-z0-9]{2,5}$/;

/** The Matrix content URI of a media reference (a cache path mapped back), or undefined: not a Beeper one. */
export function toMxc(u: string | undefined): string | undefined {
  if (!u) return undefined;
  const m = CACHE_PATH.exec(u);
  if (m && m[2]!.split('/').some((seg) => seg === '.' || seg === '..')) return undefined;
  const url = m ? `mxc://${m[1]}/${m[2]}` : u;
  return MXC.test(url) ? url : undefined;
}

export const beeperTraits = {
  id: 'beeper',
  name: 'Beeper',
  owns: isBeeperChatID,
  lowPriority: true,
  fullDelivery: false,
  // Its server half's media.params: ?url=<mxc> (validated there).
  mediaQuery(u: string): string | undefined {
    const mxc = toMxc(u);
    return mxc ? `url=${encodeURIComponent(mxc)}` : undefined;
  },
  // Thumbnails of its relay URLs: by the same Matrix content URI (content-addressed).
  thumb(path: string, q: URLSearchParams): string | undefined {
    if (!RELAY_PATH.test(path)) return undefined;
    const url = q.get('url');
    return url && /^(mxc|localmxc):\/\//.test(url) ? `url=${encodeURIComponent(url)}` : undefined;
  },
  // Native Matrix chats list no formatting yet show all the Markdown; bridged chats that list none display none.
  displaysMarkdown: (chat: { accountID?: string }) => chat.accountID === 'matrix',
};
