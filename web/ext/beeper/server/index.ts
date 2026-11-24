import { connector, definePackage } from '#core/sdk.js';
import { beeperPackage, isBeeperChatID } from '../package.js';
import { beeperAbout, beeperDiscreetNote } from '../locales/index.js';
import { desktop } from './desktop.js';
import { flushDelivered } from './delivery.js';
import { BeeperEvents, openLive } from './events.js';
import { mediaMessages, readAllLowPriority, unreadChats } from './inbox.js';
import { beeperReceipts, flushLocalRead } from './localread.js';
import { attachmentSource, beeperReactionKey, mxcMedia } from './mxc.js';
import { accountsPending, flushAccounts, knownAccount } from './accounts.js';
import { newChat } from './newchat.js';
import { streamUpload } from './upload.js';
import { tokenProblem, upstreamFailure } from './upstream.js';

// Beeper's server half: one connector, like any other (no longer the default one): its chats are Matrix room ids,
// its accounts those beeper-server lists (accounts.ts; until it first has, those no other connector claims).

let events: BeeperEvents | undefined;

export default definePackage({
  ...beeperPackage,
  about: beeperAbout,
  modules: [
    connector({
      id: 'beeper',
      check: tokenProblem,
      owns: isBeeperChatID,
      ownsAccount: knownAccount,
      // First start, before beeper-server has listed them: the accounts no other connector claims (accounts.ts).
      accountsPending,
      capabilities: { actorSend: true, flags: ['isPinned', 'isMuted', 'isLowPriority'] },
      failure: upstreamFailure,
      // Discreet reading: kept in Klatchly (localread.ts); the explicit read is the Desktop API's, which sends the receipt.
      receipts: beeperReceipts(beeperDiscreetNote, (onRead, quiet) => readAllLowPriority(onRead, quiet)),
      ...desktop,
      unreadChats,
      readAllLowPriority,
      mediaMessages,
      upload: streamUpload,
      media: mxcMedia,
      longReactionKey: beeperReactionKey,
      attachmentSource,
      newChat,
      openLive,
      start(ctx) {
        events = new BeeperEvents(ctx.feed!);
        events.start();
      },
      stop() {
        events?.stop();
        events = undefined;
        flushDelivered();
        flushLocalRead();
        flushAccounts();
      },
    }),
  ],
});
