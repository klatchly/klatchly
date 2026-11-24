import { log } from './log.js';
import { ConnectorError } from './connector.js';
import { readAfterReply } from './reading.js';
import { MAX_TEXT, validId } from './relay.js';
import { connectorFor, from } from './sources.js';

// What a space that sends on the user's behalf from outside the app (ext/share: a link shared from another app)
// gets: a plain text message sent the way the composer sends it (POST /api/chats/:id/messages: the chat's connector's
// send, then the discreet-reading receipt where replying always tells), in any chat of a connector that is on. Handed
// out by the registry to the spaces that declare it (ServerSpace.sends), bound to their package: every send is logged
// with its id and the text's length, never with the text or the chat; nothing once the package is off. Since API 1.24.

export interface ChatSender {
  /** Whether a chat id names a chat of a connector that is on (the id checked as the core's routes do). */
  canSend(chatID: string): boolean;
  /**
   * Sends `text` (trimmed non-empty, at most MAX_TEXT characters) in the chat, in the user's name, as the composer
   * does. Throws a ConnectorError: 400 'bad_request' (id or text), 404 'not_found' (no connector of it on), and the
   * connector's own errors (the sdk's fail answers them).
   */
  send(chatID: string, text: string): Promise<{ chatID?: string; pendingMessageID?: string }>;
}

/** The sender of one package. `live`: whether that package is on (the registry's); once off, every send is refused. */
export function chatSender(pkg: string, live: () => boolean = () => true): ChatSender {
  return {
    canSend: (chatID) => live() && validId(chatID) && !!connectorFor(chatID),
    async send(chatID, text) {
      if (!live()) throw new ConnectorError(404, 'not_found');
      if (!validId(chatID) || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) throw new ConnectorError(400, 'bad_request');
      const source = connectorFor(chatID);
      if (!source) throw new ConnectorError(404, 'not_found');
      const r = await from(source, () => source.send(chatID, { text }));
      void readAfterReply(source, chatID);
      log('chatsender', 'send', { pkg, source: source.id, chars: text.length });
      return { ...(r.chatID ? { chatID: r.chatID } : {}), ...(r.pendingMessageID ? { pendingMessageID: r.pendingMessageID } : {}) };
    },
  };
}
