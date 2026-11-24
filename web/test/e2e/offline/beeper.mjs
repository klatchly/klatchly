// The fake Desktop API (beeper-server) for the offline instance (server.mjs): made-up accounts, chats and histories
// kept in memory, what the beeper package calls on them (chats, messages, search, media, upload, send, edit,
// delete, reactions, read, archive, flags, contacts, new chats), and its WebSocket (/v1/ws) with the events those
// writes cause. Every name, number and picture is invented. Test hooks, on the same port, for run.mjs and the scripts:
// POST /__reset (every fake back to its start), POST /__inject (an incoming message in the test chat: the text is
// the body), POST /__inject/group (the same in the WhatsApp group), POST /__inject/react ({ mid, key, remove }: our reaction "from another device"), GET /__calls (the
// reads the fakes were asked for since the reset, harness.mjs) and POST /__<name>, the hooks the packages' fakes
// register (harness.mjs hook(): an incoming message on their network…).
// With R_ACCOUNTS=1 (the accounts dashboard's script, ext/accounts/test/accounts.e2e.cjs): more accounts, one of
// them in trouble, and a few empty chats on them.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { calls, hookFor, resetCalls } from './harness.mjs';
import { clip, pdf, picture, size, voice } from './media.mjs';

export const TEST_CHAT = '!test:beeper.local';
const SELF = '@sam:beeper.local';
const MANY = process.env.R_ACCOUNTS === '1';
const PAGE = 20;

// ── People and accounts ──

const P = {
  me: { id: SELF, fullName: 'Sam Example', isSelf: true },
  robin: { id: '@robin:beeper.local', fullName: 'Robin Test' },
  alice: { id: '@whatsapp_alice:beeper.local', fullName: 'Alice Martin', phoneNumber: '+15550100002' },
  bao: { id: '@whatsapp_bao:beeper.local', fullName: 'Bao Tran' },
  chloe: { id: '@whatsapp_chloe:beeper.local', fullName: 'Chloé Durand' },
  dmitri: { id: '@telegram_dmitri:beeper.local', fullName: 'Dmitri Ivanov', username: 'dmitri_i' },
  emma: { id: '@whatsapp_emma:beeper.local', fullName: 'Emma Wilson' },
  bob: { id: '@telegram_bob:beeper.local', fullName: 'Bob Smith', username: 'bobsmith' },
  kai: { id: '@discord_kai:beeper.local', fullName: 'Kai', username: 'kai.dev' },
  lena: { id: '@line_lena:beeper.local', fullName: 'Lena Park' },
};
const WA_CAPS = { reply: 1, edit: 1, delete: 1, reaction: 1, thread: -1, poll: 1, readReceipts: true, typingNotifications: true, archive: true, maxTextLength: 65536, attachments: { 'm.image': { maxSize: 16777216 }, 'm.video': { maxSize: 16777216 }, 'org.matrix.msc3245.voice': {}, 'm.file': { maxSize: 104857600 } } };
const ACCOUNTS = MANY
  ? [
      { accountID: 'whatsapp', bridge: { id: 'local-whatsapp', type: 'whatsapp', provider: 'local' }, network: 'WhatsApp', user: { id: SELF, fullName: 'Sam Example', phoneNumber: '+15550100001' }, status: 'connected', capabilities: WA_CAPS },
      { accountID: 'slackgo.T0001-U0001', bridge: { id: 'slackgo', type: 'slackgo', provider: 'cloud' }, network: 'Slack', user: { id: 'U0001', username: 'sam', fullName: 'Sam Example' }, status: 'reconnect_required', statusText: 'The Slack session expired' },
      { accountID: 'telegram', bridge: { id: 'telegram', type: 'telegram', provider: 'cloud' }, network: 'Telegram', user: { id: '1001', username: 'sam_example' }, status: 'backfilling' },
      { accountID: 'discordgo', bridge: { id: 'discordgo', type: 'discordgo', provider: 'cloud' }, network: 'Discord', user: { id: '2002', username: 'sam.example', fullName: 'Sam' }, status: 'connected' },
    ]
  : [
      { accountID: 'hungryserv', network: 'Beeper (Matrix)', user: { id: SELF, fullName: 'Sam Example', username: 'sam' }, status: 'connected' },
      { accountID: 'whatsapp', bridge: { id: 'whatsapp', type: 'whatsapp', provider: 'cloud' }, network: 'WhatsApp', user: { id: SELF, fullName: 'Sam Example', phoneNumber: '+15550100001' }, status: 'connected', capabilities: WA_CAPS },
      { accountID: 'telegram', bridge: { id: 'telegram', type: 'telegram', provider: 'cloud' }, network: 'Telegram', user: { id: SELF, username: 'sam_example' }, status: 'connected' },
      { accountID: 'discordgo', bridge: { id: 'discordgo', type: 'discordgo', provider: 'cloud' }, network: 'Discord', user: { id: SELF, username: 'sam.example' }, status: 'connected' },
      { accountID: 'line', bridge: { id: 'line', type: 'line', provider: 'cloud' }, network: 'LINE', user: { id: SELF, fullName: 'Sam' }, status: 'connected' },
    ];
// What each bridge allows when starting a chat (GET /v1/bridges/<id>/capabilities).
const BRIDGES = {
  whatsapp: { resolve_identifier: { create_dm: true, lookup_phone: true, contact_list: true, search: true }, group_creation: { group: { name: { allowed: true, max_length: 100 }, participants: { allowed: true, min_length: 1, max_length: 256 } } } },
  telegram: { resolve_identifier: { create_dm: true, lookup_username: true, lookup_phone: true, contact_list: true, search: true }, group_creation: { group: { name: { allowed: true, required: true }, participants: { allowed: true, min_length: 1 } } } },
  discordgo: { resolve_identifier: { create_dm: false, search: true } },
  line: { resolve_identifier: { create_dm: false } },
};
const CONTACTS = {
  whatsapp: [P.alice, P.bao, P.chloe, P.emma, { id: '@whatsapp_alicia:beeper.local', fullName: 'Alicia Gomez', phoneNumber: '+15550100009' }],
  telegram: [P.bob, P.dmitri, { id: '@telegram_alina:beeper.local', fullName: 'Alina Petrova', username: 'alina_p' }],
  discordgo: [P.kai],
  line: [P.lena],
};
const NETWORK = Object.fromEntries(ACCOUNTS.map((a) => [a.accountID, a.network]));

// ── Media ──

// Bytes by media ID (mxc://beeper.local/<id>): the dataset's, drawn once, and uploads.
const media = new Map();
const BASE_MEDIA = new Set();
const mxc = (id) => `mxc://beeper.local/${id}`;
async function drawMedia() {
  const add = async (id, buf, mime) => (media.set(id, { buf: await buf, mime }), BASE_MEDIA.add(id));
  const hues = ['#2f6fb0', '#b04a2f', '#2fb07a', '#8a2fb0', '#b0a02f', '#2fa6b0', '#b02f6a', '#5db02f'];
  await add('holiday-1', picture(1600, 1000, '#2f6fb0', 'png'), 'image/png');
  await add('holiday-2', picture(900, 1300, '#b04a2f'), 'image/jpeg');
  await add('holiday-3', picture(1200, 800, '#2fb07a', 'png'), 'image/png');
  for (let i = 0; i < 16; i++) await add(`photo-${i}`, picture(i % 3 ? 1280 : 960, i % 3 ? 960 : 1280, hues[i % hues.length]), 'image/jpeg');
  await add('clip', clip(), 'video/webm');
  await add('voice', voice(), 'audio/ogg');
  await add('report', pdf('Quarterly report'), 'application/pdf');
  await add('notes', Buffer.from('Meeting notes\n- one\n- two\n'), 'text/plain');
  // An HTML report (htmlview.e2e.js): its own styles, plus what the viewer must keep from running or loading.
  await add(
    'minutes',
    Buffer.from(
      '<!doctype html><html><head><meta charset="utf-8"><title>Compte rendu</title><style>h1{color:rgb(200,30,90)}</style></head><body>' +
        '<h1 id="t">Compte rendu de réunion</h1><p>9 actions au plan d’action</p><img id="px" src="https://tracker.example/p.gif" alt="">' +
        '<a id="l" href="https://example.com/">lien</a><script>document.getElementById("t").textContent="pwned"</script></body></html>',
    ),
    'text/html',
  );
  for (const [k, c] of Object.entries({ alice: '#c55', bao: '#5c5', chloe: '#55c', dmitri: '#cc5', emma: '#5cc', bob: '#c5c', robin: '#888', kai: '#a85', lena: '#58a', group: '#777' }))
    await add(`avatar-${k}`, picture(96, 96, c), 'image/jpeg');
  await add('reaction-cat', picture(64, 64, '#fa0', 'png'), 'image/png');
  // The busy group (scrollup.e2e.js): stickers (square PNGs, sent with or without their size).
  for (let i = 0; i < 4; i++) await add(`sticker-${i}`, picture(512, 512, hues[(i * 3) % hues.length], 'png'), 'image/png');
}
const img = (id, w, h, o = {}) => ({ id: mxc(id), type: 'img', srcURL: mxc(id), mimeType: media.get(id)?.mime ?? 'image/jpeg', fileName: `${id}.${media.get(id)?.mime === 'image/png' ? 'png' : 'jpg'}`, fileSize: media.get(id)?.buf.length, size: { width: w, height: h }, ...o });
const photo = (i) => img(`photo-${i}`, i % 3 ? 1280 : 960, i % 3 ? 960 : 1280);

// ── The dataset ──

let state;
let seq = 0;

/** Chats and histories as they are at the start of every script (relative to now). */
function build() {
  const now = Date.now();
  seq = 1_000_000;
  const chats = new Map();
  const messages = new Map();
  const chat = (id, o, people) => {
    const c = {
      id,
      localChatID: String(chats.size + 1),
      accountID: 'whatsapp',
      title: '',
      type: 'single',
      participants: { items: [P.me, ...people], hasMore: false, total: people.length + 1 },
      lastActivity: new Date(now - 86_400_000).toISOString(),
      unreadCount: 0,
      isArchived: false,
      isMuted: false,
      isPinned: false,
      isLowPriority: false,
      ...o,
    };
    c.network = NETWORK[c.accountID] ?? c.accountID;
    chats.set(id, c);
    messages.set(id, []);
    return c;
  };
  // One message, appended (histories are written oldest first); `at` in minutes before now.
  const say = (c, who, at, o = {}) => {
    const m = {
      id: `$${c.localChatID}-${messages.get(c.id).length + 1}`,
      chatID: c.id,
      accountID: c.accountID,
      senderID: who.id,
      senderName: who.fullName,
      timestamp: new Date(now - at * 60_000).toISOString(),
      sortKey: String(++seq),
      type: 'TEXT',
      text: '',
      isSender: who.id === SELF,
      isDeleted: false,
      ...o,
    };
    messages.get(c.id).push(m);
    return m;
  };
  const words = ['sounds good', 'see you there', 'what about tomorrow?', 'I sent the files', 'thanks a lot', 'on my way', 'let me check', 'great idea', 'perfect', 'can you call me later?'];
  const filler = (c, people, n, from, step, o = {}) => {
    for (let i = 0; i < n; i++) {
      const who = i % 3 === 2 ? P.me : people[i % people.length];
      const text = i % 9 === 4 ? `${words[i % words.length]}\nand a second line\nand a third one` : i % 7 === 3 ? `${words[(i * 3) % words.length]} — ${'a longer message that wraps over several lines in the bubble, '.repeat(2).trim()}` : `${words[(i * 7) % words.length]} (${i + 1})`;
      say(c, who, from - i * step, { text, ...o });
    }
  };

  if (MANY) {
    const base = chat(TEST_CHAT, { title: 'Test', lastActivity: new Date(now).toISOString() }, [P.robin]);
    const extra = (n, accountID, over = {}) => chat(`!fake${n}:beeper.local`, { accountID, title: `Example ${NETWORK[accountID]} ${n}`, lastActivity: new Date(now - n * 90 * 60_000).toISOString(), ...over }, [P.robin]);
    void base;
    extra(1, 'whatsapp', { unreadCount: 3, type: 'group' });
    extra(2, 'whatsapp', { isLowPriority: true });
    extra(3, 'whatsapp', { isArchived: true });
    extra(4, 'slackgo.T0001-U0001', { type: 'group' });
    extra(5, 'telegram', { unreadCount: 1 });
    extra(6, 'discordgo', { type: 'group', isMuted: true });
    return { chats, messages, uploads: new Map() };
  }

  // The test chat (on the Beeper account, archived, as on a real account where it is kept out of the way): a long history, our messages
  // with read and sent ticks, an edit, a deletion, a reply, a voice note, a PDF, a link, and an album of three
  // pictures sent within a minute, the first with a caption.
  const t = chat(TEST_CHAT, { accountID: 'hungryserv', title: 'Test', isArchived: true, imgURL: mxc('avatar-robin') }, [P.robin]);
  filler(t, [P.robin], 34, 2000, 50);
  const quoted = say(t, P.me, 290, { text: 'Where do we meet?' });
  say(t, P.me, 280, { text: 'Edited message (final)', editedTimestamp: new Date(now - 279 * 60_000).toISOString() });
  say(t, P.me, 270, { text: '', isDeleted: true });
  say(t, P.robin, 260, { text: 'At the station', linkedMessageID: quoted.id });
  say(t, P.robin, 200, { type: 'VOICE', attachments: [{ id: mxc('voice'), type: 'audio', srcURL: mxc('voice'), mimeType: 'audio/ogg', fileName: 'voice.ogg', fileSize: media.get('voice').buf.length, isVoiceNote: true, duration: 3 }] });
  say(t, P.me, 150, { type: 'FILE', attachments: [{ id: mxc('report'), type: 'unknown', srcURL: mxc('report'), mimeType: 'application/pdf', fileName: 'report.pdf', fileSize: media.get('report').buf.length }] });
  say(t, P.me, 100, { type: 'FILE', attachments: [{ id: mxc('notes'), type: 'unknown', srcURL: mxc('notes'), mimeType: 'text/plain', fileName: 'notes.txt', fileSize: media.get('notes').buf.length }] });
  say(t, P.me, 60, { type: 'IMAGE', text: 'Holiday photos', attachments: [img('holiday-1', 1600, 1000)] });
  say(t, P.me, 59.7, { type: 'IMAGE', attachments: [img('holiday-2', 900, 1300)] });
  say(t, P.me, 59.4, { type: 'IMAGE', attachments: [img('holiday-3', 1200, 800)] });
  const link = say(t, P.robin, 40, { text: 'Details on https://example.com/ as promised' });
  // Robin read up to the link (our older messages: read); the last one only sent.
  link.seen = { [P.robin.id]: new Date(now - 39 * 60_000).toISOString() };
  say(t, P.me, 20, { text: 'Last test message' });
  t.lastActivity = new Date(now - 20 * 60_000).toISOString();

  // A long one-to-one history (scrolling).
  const alice = chat('!alice:beeper.local', { title: 'Alice Martin', imgURL: mxc('avatar-alice') }, [P.alice]);
  filler(alice, [P.alice], 240, 6000, 24);
  alice.lastActivity = new Date(now - 30 * 60_000).toISOString();

  // A group with five members, the call-event message and mentions allowed.
  const group = chat('!hikers:beeper.local', { title: 'Weekend hikers', type: 'group', imgURL: mxc('avatar-group'), capabilities: { reply: 1, edit: 1, delete: 1, reaction: 1, formatting: { user_link: 1, bold: 1, italic: 1 } } }, [P.alice, P.bao, P.chloe, P.emma]);
  filler(group, [P.alice, P.bao, P.chloe, P.emma], 40, 900, 20);
  say(group, P.bao, 45, {
    text: '<h4>Trail planning</h4><p>\n\t\tStart time: Sat, 07 Nov 2026 07:00:00 UTC</p><p></p><ul><li>Route choice</li><li>Car sharing</li></ul><p></p><p>Join link: <a href="https://call.whatsapp.com/video/OfflineFakeToken1" rel="noopener noreferrer" target="_blank">https://call.whatsapp.com/video/OfflineFakeToken1</a></p>',
  });
  say(group, P.chloe, 44, { text: 'I can drive <strong>two</strong> people' });
  group.lastActivity = new Date(now - 44 * 60_000).toISOString();

  // Pictures: albums (one with more than four), a video (no poster: its first frame stands for it), a reply to a photo.
  const bob = chat('!bob:beeper.local', { accountID: 'telegram', title: 'Bob Smith', imgURL: mxc('avatar-bob') }, [P.bob]);
  filler(bob, [P.bob], 12, 3000, 60);
  let k = 0;
  for (const [who, at, n] of [[P.bob, 600, 2], [P.me, 400, 3], [P.bob, 200, 6], [P.bob, 120, 1], [P.me, 90, 2]]) {
    for (let i = 0; i < n; i++) say(bob, who, at - i * 0.2, { type: 'IMAGE', attachments: [photo(k++ % 16)] });
    if (who === P.bob && n === 1) say(bob, P.me, at - 5, { text: 'Nice one!', linkedMessageID: messages.get(bob.id).at(-1).id });
  }
  say(bob, P.bob, 60, { type: 'VIDEO', text: 'The view from the top', attachments: [{ id: mxc('clip'), type: 'video', srcURL: mxc('clip'), mimeType: 'video/webm', fileName: 'clip.webm', fileSize: media.get('clip').buf.length, size: { width: 320, height: 240 }, duration: 2 }] });
  say(bob, P.bob, 50, { text: 'Did you get them?' });
  bob.lastActivity = new Date(now - 50 * 60_000).toISOString();

  // Unread chats.
  const tg = chat('!tgfriends:beeper.local', { accountID: 'telegram', title: 'Telegram friends', type: 'group', unreadCount: 2 }, [P.bob, P.dmitri]);
  filler(tg, [P.bob, P.dmitri], 30, 1500, 30);
  say(tg, P.dmitri, 12, { text: 'Anyone up for lunch?' });
  say(tg, P.bob, 10, { text: 'Me!' });
  tg.lastActivity = new Date(now - 10 * 60_000).toISOString();
  const emma = chat('!emma:beeper.local', { title: 'Emma Wilson', unreadCount: 1, imgURL: mxc('avatar-emma') }, [P.emma]);
  filler(emma, [P.emma], 25, 3000, 80);
  say(emma, P.emma, 5, { text: 'Are you coming tonight?' });
  emma.lastActivity = new Date(now - 5 * 60_000).toISOString();

  // More of the inbox.
  const fill = (id, o, people, n, from) => {
    const c = chat(id, o, people);
    filler(c, people, n, from, 40);
    c.lastActivity = messages.get(id).at(-1).timestamp;
    return c;
  };
  const chloe = fill('!chloe:beeper.local', { title: 'Chloé Durand', imgURL: mxc('avatar-chloe') }, [P.chloe], 25, 1200);
  say(chloe, P.chloe, 210, { type: 'FILE', attachments: [{ id: mxc('minutes'), type: 'unknown', srcURL: mxc('minutes'), mimeType: 'text/html', fileName: 'compte-rendu-neo-pyrgi.html', fileSize: media.get('minutes').buf.length }] });
  say(chloe, P.chloe, 200, { type: 'FILE', text: 'The report', attachments: [{ id: mxc('report'), type: 'unknown', srcURL: mxc('report'), mimeType: 'application/pdf', fileName: 'report.pdf', fileSize: media.get('report').buf.length }] });
  chloe.lastActivity = messages.get(chloe.id).at(-1).timestamp;
  fill('!dmitri:beeper.local', { accountID: 'telegram', title: 'Dmitri Ivanov', imgURL: mxc('avatar-dmitri') }, [P.dmitri], 25, 1400);
  const family = fill('!family:beeper.local', { title: 'Family', type: 'group', isPinned: true }, [P.alice, P.emma], 25, 1600);
  for (let i = 0; i < 3; i++) say(family, P.emma, 630 - i * 30, { type: 'IMAGE', attachments: [photo(10 + i)] });
  say(family, P.alice, 560, { text: 'Lovely pictures' });
  family.lastActivity = messages.get(family.id).at(-1).timestamp;
  fill('!discord:beeper.local', { accountID: 'discordgo', title: 'general', type: 'group', isMuted: true }, [P.kai], 25, 1800);
  const line = fill('!line:beeper.local', { accountID: 'line', title: 'Lena Park', imgURL: mxc('avatar-lena') }, [P.lena], 10, 2000);
  // A reaction made with a LINE sticker (a picture, not an emoji): LINE_QUERY finds it (run.mjs).
  say(line, P.lena, 1500, { text: 'Look at this sticker reaction', reactions: [{ id: 'r-cat', reactionKey: mxc('reaction-cat'), imgURL: mxc('reaction-cat'), emoji: false, participantID: P.lena.id }] });
  line.lastActivity = messages.get(line.id).at(-1).timestamp;

  // Older ones, enough for the list to scroll on a phone whatever other connectors the build has (iphone.e2e.js).
  fill('!bao:beeper.local', { title: 'Bao Tran' }, [P.bao], 10, 4000);
  fill('!bookclub:beeper.local', { accountID: 'telegram', title: 'Book club', type: 'group' }, [P.bob, P.dmitri], 10, 4500);
  fill('!neighbours:beeper.local', { title: 'Neighbours', type: 'group' }, [P.chloe, P.emma], 10, 5000);

  // Low priority (muted by the move, one unread), and archived.
  fill('!newsletter:beeper.local', { title: 'Daily newsletter', type: 'group', isLowPriority: true, isMuted: true, unreadCount: 3 }, [P.bao], 12, 300);
  fill('!shop:beeper.local', { accountID: 'telegram', title: 'Shop updates', isLowPriority: true }, [P.dmitri], 8, 900);
  fill('!oldproject:beeper.local', { title: 'Old project', type: 'group', isArchived: true }, [P.bao, P.chloe], 15, 20000);

  // A busy group (scrollup.e2e.js: scrolling up through its older pages), archived and old, out of the inbox: over a
  // dozen pages of everything a lively group carries — photos with and without their size, albums, stickers with and
  // without it, link previews (the network's, with a picture, and generated ones), voice notes, replies, reactions,
  // long texts, several days, runs of one sender.
  const market = chat('!market:beeper.local', { title: 'Market stall', type: 'group', isArchived: true, imgURL: mxc('avatar-group') }, [P.alice, P.bao, P.chloe, P.emma]);
  {
    const people = [P.alice, P.bao, P.chloe, P.emma, P.me];
    const emojis = ['👍', '❤️', '😂', '🔥', '🙏', '😮'];
    const reactions = (i) =>
      i % 4 === 1 ? Array.from({ length: 1 + (i % 3) }, (_, k) => ({ id: `r${i}-${k}`, reactionKey: emojis[(i + k) % emojis.length], emoji: true, participantID: people[(i + k) % 4].id })) : undefined;
    const sticker = (i, sized) => ({ id: mxc(`sticker-${i % 4}`), type: 'img', isSticker: true, srcURL: mxc(`sticker-${i % 4}`), mimeType: 'image/png', fileName: 'sticker.png', ...(sized ? { size: { width: 512, height: 512 } } : {}) });
    const unsized = (i) => ({ ...photo(i % 16), size: undefined });
    let at = 14 * 24 * 60;
    for (let i = 0; i < 300; i++) {
      // Runs of one sender (2–3 messages), a gap of hours every 25 messages (a new day).
      const who = people[Math.floor(i / 3) % people.length];
      at -= i % 25 === 0 ? 600 : 3 + (i % 5);
      const o = { reactions: reactions(i) };
      const prev = messages.get(market.id).at(-1);
      switch (i % 17) {
        case 0: Object.assign(o, { type: 'IMAGE', attachments: [photo(i % 16)] }); break;
        case 2: Object.assign(o, { type: 'IMAGE', attachments: [unsized(i)] }); break;
        case 4: Object.assign(o, { type: 'IMAGE', attachments: [sticker(i, i % 2 === 0)] }); break;
        case 6: Object.assign(o, { text: `Prices for tomorrow on https://example.com/ (${i})` }); break;
        case 8: Object.assign(o, { text: `Have a look https://github.com/beeper/desktop-api-js (${i})`, links: [{ url: 'https://github.com/beeper/desktop-api-js', title: 'beeper/desktop-api-js', summary: 'The Desktop API client.', img: mxc(`photo-${i % 16}`), imgSize: { width: 1280, height: 960 } }] }); break;
        case 10: Object.assign(o, { type: 'VOICE', attachments: [{ id: mxc('voice'), type: 'audio', srcURL: mxc('voice'), mimeType: 'audio/ogg', fileName: 'voice.ogg', fileSize: media.get('voice').buf.length, isVoiceNote: true, duration: 3 + (i % 40) }] }); break;
        case 12: Object.assign(o, { text: `Agreed (${i})`, linkedMessageID: prev?.id }); break;
        case 14: Object.assign(o, { text: `${'The delivery came late again this morning, so we moved the stand to the other end of the square and sold out of apples before noon. '.repeat(2 + (i % 3)).trim()} (${i})` }); break;
        case 15: Object.assign(o, { type: 'IMAGE', attachments: [sticker(i + 1, false)] }); break;
        default: Object.assign(o, { text: `${words[(i * 7) % words.length]} (${i})` });
      }
      say(market, who, at, o);
      // An album now and then: three pictures within a minute.
      if (i % 40 === 20) for (let k = 0; k < 3; k++) say(market, who, at - 0.1 * (k + 1), { type: 'IMAGE', attachments: [k === 1 ? unsized(i + k) : photo((i + k) % 16)] });
    }
    market.lastActivity = messages.get(market.id).at(-1).timestamp;
  }

  for (const c of chats.values()) c.preview = latest(messages.get(c.id));
  return { chats, messages, uploads: new Map() };
}

const latest = (list) => [...list].reverse().find((m) => m.type !== 'REACTION' && !m.isHidden);

// ── Live events ──

const sockets = new Set();
function emit(ev) {
  const text = JSON.stringify(ev);
  for (const s of sockets) if (s.all || s.chats.has(ev.chatID)) s.ws.send(text);
}
const chatUpserted = (c) => emit({ type: 'chat.upserted', chatID: c.id, entries: [c] });
const messageUpserted = (m) => emit({ type: 'message.upserted', chatID: m.chatID, entries: [m] });

// ── Helpers ──

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** What the bridge does with the Markdown of a sent text: rich text (HTML) for bold, italics, code and http(s) links. */
function formatted(text) {
  if (!/\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:[^)\s]+\)|(^|\s)_[^_]+_(\s|$)/.test(text)) return text;
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n/g, '<br>');
}
const plain = (s) => (s ?? '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function pageOf(list, url, key = (x) => x.sortKey) {
  const cursor = url.searchParams.get('cursor');
  const after = url.searchParams.get('direction') === 'after';
  const limit = Math.min(Number(url.searchParams.get('limit')) || PAGE, 200);
  // Newest first.
  let items = [...list].sort((a, b) => (key(a) < key(b) ? 1 : -1));
  if (cursor) items = items.filter((x) => (after ? key(x) > cursor : key(x) < cursor));
  const out = after ? items.slice(-limit) : items.slice(0, limit);
  return { items: out, hasMore: items.length > out.length, oldestCursor: out.length ? key(out.at(-1)) : null, newestCursor: out.length ? key(out[0]) : null };
}
const chatKey = (c) => `${c.lastActivity}|${c.id}`;
const sortedChats = () => [...state.chats.values()].sort((a, b) => (chatKey(a) < chatKey(b) ? 1 : -1));
const all = (url, name) => [...url.searchParams.getAll(name), ...url.searchParams.getAll(`${name}[]`)];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
const json = (buf) => {
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    return {};
  }
};

/** The parts of a multipart/form-data body (uploads). */
function multipart(buf, type) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type ?? '');
  if (!boundary) return {};
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = {};
  let at = buf.indexOf(sep);
  while (at >= 0) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = buf.subarray(at + sep.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (name) parts[name] = part.subarray(split + 4);
    at = next;
  }
  return parts;
}

function attachmentOf(up, kind) {
  const base = { id: mxc(up.id), srcURL: mxc(up.id), mimeType: up.mime, fileName: up.fileName, fileSize: up.buf.length };
  if (up.mime.startsWith('image/')) return { ...base, type: 'img', ...(up.size ? { size: up.size } : {}), ...(up.mime === 'image/gif' ? { isGif: true } : {}) };
  if (up.mime.startsWith('video/')) return { ...base, type: 'video', ...(up.size ? { size: up.size } : {}) };
  if (up.mime.startsWith('audio/')) return { ...base, type: 'audio', ...(kind === 'voice-note' ? { isVoiceNote: true } : {}) };
  return { ...base, type: 'unknown' };
}
const typeOf = (a) => (!a ? 'TEXT' : a.type === 'img' ? 'IMAGE' : a.type === 'video' ? 'VIDEO' : a.type === 'audio' ? (a.isVoiceNote ? 'VOICE' : 'AUDIO') : 'FILE');

/** A new message at the end of a chat, with its live events (the chat moves up and leaves the archive). */
function append(c, o) {
  const list = state.messages.get(c.id);
  const m = { id: `$${c.localChatID}-${list.length + 1}`, chatID: c.id, accountID: c.accountID, timestamp: new Date().toISOString(), sortKey: String(++seq), type: 'TEXT', text: '', isDeleted: false, ...o };
  list.push(m);
  c.lastActivity = m.timestamp;
  c.preview = m;
  if (m.isSender) c.isArchived = false;
  else c.unreadCount += 1;
  messageUpserted(m);
  chatUpserted(c);
  return m;
}

// ── Routes ──

async function route(req, url, body) {
  const p = url.pathname;
  const method = req.method;
  let m;
  if (p === '/v1/info') return [200, { app: { name: 'beeper-server (offline fake)', version: '0.0.0' } }];
  if (p === '/v1/accounts' && method === 'GET') return [200, ACCOUNTS];
  if ((m = /^\/v1\/accounts\/([^/]+)$/.exec(p))) {
    const a = ACCOUNTS.find((x) => x.accountID === decodeURIComponent(m[1]));
    return a ? [200, a] : [404, { message: 'not found' }];
  }
  if ((m = /^\/v1\/accounts\/([^/]+)\/contacts(\/list)?$/.exec(p))) {
    const list = CONTACTS[decodeURIComponent(m[1])] ?? [];
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const items = m[2] ? list : list.filter((x) => [x.fullName, x.username, x.phoneNumber].some((v) => v && v.toLowerCase().includes(q)));
    return [200, { items, hasMore: false, oldestCursor: null }];
  }
  if ((m = /^\/v1\/bridges\/([^/]+)\/capabilities$/.exec(p))) {
    const caps = BRIDGES[decodeURIComponent(m[1])];
    return caps ? [200, caps] : [400, { message: 'Invalid bridgeID' }];
  }
  if (p === '/v1/chats' && method === 'GET') {
    const ids = all(url, 'accountIDs');
    // The inbox: archived chats only through the search (inbox=archive).
    return [200, pageOf(sortedChats().filter((c) => !c.isArchived && (!ids.length || ids.includes(c.accountID))), url, chatKey)];
  }
  if (p === '/v1/chats/search') {
    const ids = all(url, 'accountIDs');
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const inbox = url.searchParams.get('inbox');
    const items = sortedChats().filter(
      (c) =>
        (!ids.length || ids.includes(c.accountID)) &&
        (!q || c.title.toLowerCase().includes(q) || c.participants.items.some((x) => !x.isSelf && x.fullName?.toLowerCase().includes(q))) &&
        (inbox === 'archive' ? c.isArchived : inbox === 'low-priority' ? c.isLowPriority && !c.isArchived : inbox === 'primary' ? !c.isArchived && !c.isLowPriority : true),
    );
    return [200, pageOf(items, url, chatKey)];
  }
  if (p === '/v1/chats/start' && method === 'POST') {
    const b = json(body);
    const existing = sortedChats().find((c) => c.type === 'single' && c.accountID === b.accountID && c.participants.items.some((x) => x.id === b.user?.id));
    return existing ? [200, existing] : [404, { message: 'not found', code: 'not_found' }];
  }
  if (p === '/v1/chats' && method === 'POST') return [400, { message: 'not supported offline' }];
  if (p === '/v1/messages/search') {
    const chatIDs = all(url, 'chatIDs');
    const types = all(url, 'mediaTypes');
    const ids = all(url, 'accountIDs');
    const q = (url.searchParams.get('query') ?? '').toLowerCase();
    const kind = (a) => (a.type === 'img' ? 'image' : a.type === 'video' ? 'video' : 'file');
    const found = [...state.messages.values()].flat().filter((x) => {
      const c = state.chats.get(x.chatID);
      if (x.isDeleted || (chatIDs.length && !chatIDs.includes(x.chatID)) || (ids.length && !ids.includes(c.accountID))) return false;
      if (q && !plain(x.text).toLowerCase().includes(q)) return false;
      if (types.length && !types.some((t) => (t === 'link' ? /https?:\/\//.test(x.text ?? '') && !x.attachments?.length : (x.attachments ?? []).some((a) => kind(a) === t)))) return false;
      return true;
    });
    const page = pageOf(found, url);
    return [200, { ...page, chats: Object.fromEntries(page.items.map((x) => [x.chatID, state.chats.get(x.chatID)])) }];
  }
  if (p === '/v1/assets/upload' && method === 'POST') {
    const parts = multipart(body, req.headers['content-type']);
    if (!parts.file) return [400, { message: 'no file' }];
    const id = `up-${++seq}`;
    const mime = parts.mimeType?.toString() || 'application/octet-stream';
    const up = { id, buf: Buffer.from(parts.file), mime, fileName: parts.fileName?.toString() || 'file', size: mime.startsWith('image/') ? await size(parts.file) : null };
    media.set(id, { buf: up.buf, mime });
    state.uploads.set(id, up);
    return [200, { uploadID: id, srcURL: `file:///data/uploads/${id}`, fileName: up.fileName, mimeType: mime, fileSize: up.buf.length, ...(up.size ?? {}) }];
  }
  if (!(m = /^\/v1\/chats\/([^/]+)(\/.*)?$/.exec(p))) return [404, { message: 'not found' }];
  const c = state.chats.get(decodeURIComponent(m[1]));
  if (!c) return [404, { message: 'chat not found' }];
  const sub = m[2] ?? '';
  const list = state.messages.get(c.id);
  if (sub === '' && method === 'GET') return [200, c];
  if (sub === '' && method === 'PATCH') {
    const b = json(body);
    for (const k of ['isPinned', 'isMuted', 'isLowPriority']) if (typeof b[k] === 'boolean') c[k] = b[k];
    chatUpserted(c);
    return [200, c];
  }
  if (sub === '/archive' && method === 'POST') {
    c.isArchived = json(body).archived !== false;
    chatUpserted(c);
    return [200, { success: true }];
  }
  if (sub === '/read' && method === 'POST') {
    calls.beeperReads.push(c.id);
    c.unreadCount = 0;
    chatUpserted(c);
    return [200, { success: true }];
  }
  if (sub === '/messages' && method === 'GET') return [200, pageOf(list, url)];
  if (sub === '/messages' && method === 'POST') {
    const b = json(body);
    const up = b.attachment ? state.uploads.get(b.attachment.uploadID) : null;
    if (b.attachment && !up) return [400, { message: 'unknown upload' }];
    const att = up ? { ...attachmentOf(up, b.attachment.type), ...(b.attachment.fileName ? { fileName: b.attachment.fileName } : {}) } : null;
    const pendingMessageID = `~${++seq}`;
    // The copy comes back over the socket a moment later, with its own ID.
    setTimeout(
      () => append(c, { senderID: SELF, senderName: P.me.fullName, isSender: true, type: typeOf(att), text: b.text ? formatted(b.text) : '', ...(att ? { attachments: [att] } : {}), ...(b.replyToMessageID ? { linkedMessageID: b.replyToMessageID } : {}) }),
      150,
    );
    return [200, { chatID: c.id, pendingMessageID }];
  }
  const mm = /^\/messages\/([^/]+)(\/reactions(?:\/([^/]+))?)?$/.exec(sub);
  const msg = mm && list.find((x) => x.id === decodeURIComponent(mm[1]));
  if (!msg) return [404, { message: 'message not found' }];
  if (!mm[2] && method === 'GET') return [200, msg];
  if (!mm[2] && method === 'PUT') {
    msg.text = formatted(String(json(body).text ?? ''));
    msg.editedTimestamp = new Date().toISOString();
    messageUpserted(msg);
    return [200, { success: true }];
  }
  if (!mm[2] && method === 'DELETE') {
    Object.assign(msg, { isDeleted: true, text: '', attachments: [] });
    messageUpserted(msg);
    return [200, { success: true }];
  }
  if (mm[2] && method === 'POST') return react(msg, String(json(body).reactionKey ?? ''), false);
  if (mm[2] && method === 'DELETE' && mm[3]) return react(msg, decodeURIComponent(mm[3]), true);
  return [404, { message: 'not found' }];
}

/** Our reaction added or removed (from this app or "another device"): the updated message over the socket. */
function react(msg, key, remove) {
  if (!key) return [400, { message: 'no reactionKey' }];
  const others = (msg.reactions ?? []).filter((r) => !(r.participantID === SELF && r.reactionKey === key));
  msg.reactions = remove ? others : [...others, { id: `${SELF}|${key}`, reactionKey: key, participantID: SELF, emoji: true }];
  if (!msg.reactions.length) delete msg.reactions;
  setTimeout(() => messageUpserted(msg), 100);
  return [200, { success: true }];
}

/** GET /v1/assets/serve?url=mxc://…, with ranges (audio and video). */
function serve(req, res, url) {
  const id = /^mxc:\/\/beeper\.local\/([A-Za-z0-9._=-]+)$/.exec(url.searchParams.get('url') ?? '')?.[1];
  const item = id && media.get(id);
  if (!item) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"not found"}');
  const total = item.buf.length;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : total - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    res.writeHead(206, { 'content-type': item.mime, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${total}`, 'accept-ranges': 'bytes' });
    return res.end(item.buf.subarray(start, end + 1));
  }
  res.writeHead(200, { 'content-type': item.mime, 'content-length': String(total), 'accept-ranges': 'bytes' });
  res.end(item.buf);
}

let resetAll = async () => {};

export function reset() {
  resetCalls();
  for (const id of media.keys()) if (!BASE_MEDIA.has(id)) media.delete(id);
  state = build();
  // The app's own copy of every chat (badge, push) follows the reset.
  for (const c of state.chats.values()) chatUpserted(c);
}

export async function start({ index, reset: resetEvery }) {
  resetAll = resetEvery;
  await drawMedia();
  state = build();
  const port = 23999 + index;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    // Test hooks (no token: only this container reaches them).
    if (url.pathname === '/__reset') return void (await resetAll(), res.writeHead(200).end('ok'));
    if (url.pathname === '/__inject') {
      append(state.chats.get(TEST_CHAT), { senderID: P.robin.id, senderName: P.robin.fullName, isSender: false, text: body.toString('utf8') || 'incoming' });
      return res.writeHead(200).end('ok');
    }
    if (url.pathname === '/__calls') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(calls));
    // An incoming message from Bao in the WhatsApp group (quiet.e2e.js): a chat of the inbox, on a network.
    if (url.pathname === '/__inject/group') {
      append(state.chats.get('!hikers:beeper.local'), { senderID: P.bao.id, senderName: P.bao.fullName, isSender: false, text: body.toString('utf8') || 'incoming' });
      return res.writeHead(200).end('ok');
    }
    if (url.pathname === '/__inject/react') {
      const b = json(body);
      const msg = state.messages.get(TEST_CHAT).find((x) => x.id === b.mid);
      if (!msg) return res.writeHead(404).end('no such message');
      react(msg, String(b.key ?? ''), !!b.remove);
      return res.writeHead(200).end('ok');
    }
    // A package's fake hook (harness.mjs).
    const hooked = url.pathname.startsWith('/__') && hookFor(url.pathname.slice(3));
    if (hooked) return void (await hooked(body.toString('utf8')), res.writeHead(200).end('ok'));
    if (req.headers.authorization !== 'Bearer offline-token') return res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"unauthorized"}');
    if (url.pathname === '/v1/assets/serve') return serve(req, res, url);
    const [status, out] = await route(req, url, body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  // Its WebSocket: 'ready' on connect, then the events of the chats each socket subscribed to.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== '/v1/ws' || req.headers.authorization !== 'Bearer offline-token') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const s = { ws, all: false, chats: new Set() };
      sockets.add(s);
      ws.on('close', () => sockets.delete(s));
      ws.send(JSON.stringify({ type: 'ready' }));
      ws.on('message', (data) => {
        let m;
        try {
          m = JSON.parse(String(data));
        } catch {
          return;
        }
        if (m.type !== 'subscriptions.set' || !Array.isArray(m.chatIDs)) return;
        s.all = m.chatIDs.includes('*');
        s.chats = new Set(m.chatIDs);
        ws.send(JSON.stringify({ type: 'subscriptions.updated', chatIDs: m.chatIDs }));
      });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { env: { KLATCHLY_UPSTREAM: `http://127.0.0.1:${port}` } };
}

