// A WeChat Channels video shared in a chat. The bridge gives it as text only, with no thumbnail nor link:
// "Channels: <author>\n<description>\nOpen WeChat to view it.". The bubble shows it as a small card (who posted the
// video, its description, where to watch it); previews keep the text. Pure, shared by the server and the client.

import { toPlainText } from './richtext.js';

export interface ChannelsShare {
  author: string;
  description: string;
}

const HEAD = /^Channels:[ \t]*(\S.*)/;
const TAIL = /\n?[ \t]*Open WeChat to view it\.?[ \t]*$/;

type Shared = { accountID?: string; text?: string; attachments?: readonly unknown[] };

/** The shared video of a WeChat message in the bridge's Channels shape, or null. */
export function parseChannelsShare(m: Shared): ChannelsShare | null {
  if (!m.text || m.attachments?.length || !m.accountID?.startsWith('wechat')) return null;
  const text = toPlainText(m.text);
  const head = HEAD.exec(text);
  if (!head || !TAIL.test(text)) return null;
  return { author: head[1]!.trim(), description: text.slice(head[0].length).replace(TAIL, '').trim() };
}
