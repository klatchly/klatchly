import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelsShare } from '../server/wechatshare.js';

// As the Desktop API returns a WeChat Channels share (escaped twice: "A&amp;amp;B").
const text =
  'Channels: Lumière简\n2026 Spring Dance Day ❤️\nThanks @ExampleDanceStudio!!! \n\n📍Lyon A&amp;amp;B Dance Center\n\n#dance #里昂\nOpen WeChat to view it.';
const wechat = 'wechat.wxid_example';

test('a WeChat Channels share becomes its author and description', () => {
  assert.deepEqual(parseChannelsShare({ accountID: wechat, text }), {
    author: 'Lumière简',
    description: '2026 Spring Dance Day ❤️\nThanks @ExampleDanceStudio!!! \n\n📍Lyon A&B Dance Center\n\n#dance #里昂',
  });
  assert.deepEqual(parseChannelsShare({ accountID: wechat, text: 'Channels: Someone\nOpen WeChat to view it.' }), { author: 'Someone', description: '' });
});

test('anything else is not a Channels share', () => {
  assert.equal(parseChannelsShare({ accountID: 'whatsapp', text }), null, 'another network');
  assert.equal(parseChannelsShare({ accountID: wechat, text, attachments: [{}] }), null, 'with an attachment');
  assert.equal(parseChannelsShare({ accountID: wechat, text: 'Channels: a talk about TV\nsee you' }), null, 'no closing line');
  assert.equal(parseChannelsShare({ accountID: wechat, text: 'I said Channels: x\nOpen WeChat to view it.' }), null, 'not at the start');
  assert.equal(parseChannelsShare({ accountID: wechat, text: 'Channels:\nOpen WeChat to view it.' }), null, 'no author');
  assert.equal(parseChannelsShare({ accountID: wechat }), null);
});
