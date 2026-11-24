// A WhatsApp scheduled call ("call event") as the Desktop API delivers it, sanitized (names, topics and the
// join link token are fake). The same message has two shapes: rich text in message lists, Markdown with
// escaped "<>" in the chat list preview. Whitespace is as received.

export const callMessage = {
  id: 'call-1',
  chatID: '!group:beeper.local',
  accountID: 'whatsapp',
  senderID: '@whatsapp_lid-100:beeper.local',
  senderName: 'Alice Martin',
  timestamp: '2026-11-02T09:12:00.000Z',
  sortKey: '1000',
  type: 'TEXT',
  isSender: false,
  isDeleted: false,
  mentions: [],
  text:
    '<h4>call</h4><p>\n\t\tStart time: Tue, 03 Nov 2026 05:00:00 UTC</p><p></p><ul><li>Acme Tech (current state, release planning)</li><li>Project B (questions from Bob)</li></ul><p></p><p>Join link: <a href="https://call.whatsapp.com/video/FakeToken123abc" rel="noopener noreferrer" target="_blank">https://call.whatsapp.com/video/FakeToken123abc</a></p>',
};

export const callPreviewText =
  '#### call\n\nStart time: Tue, 03 Nov 2026 05:00:00 UTC\n\n\n\n* Acme Tech (current state, release planning)\n* Project B (questions from Bob)\n\n\n\nJoin link: &lt;https://call.whatsapp.com/video/FakeToken123abc&gt;';
