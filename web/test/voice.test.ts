import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oggCrc, opusSamples, parseWebmOpus, toOggOpus } from '../client/src/oggopus.js';
import { withMentions } from '../client/src/mentions.js';

// Minimal EBML writer for synthetic MediaRecorder-like WebM files.
const vint = (n: number) => {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len);
      let v = n;
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0]! |= 0x80 >> (len - 1);
      return out;
    }
  }
  throw new Error('too big');
};
const idBytes = (id: number) => {
  const b: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) b.unshift(v & 0xff);
  return Uint8Array.from(b);
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
};
const el = (id: number, ...body: Uint8Array[]) => {
  const data = cat(...body);
  return cat(idBytes(id), vint(data.length), data);
};
const unknown = (id: number, ...body: Uint8Array[]) => cat(idBytes(id), Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...body);
const str = (s: string) => new TextEncoder().encode(s);

function opusHead(channels: number, preSkip: number) {
  const h = new Uint8Array(19);
  h.set(str('OpusHead'));
  h[8] = 1;
  h[9] = channels;
  new DataView(h.buffer).setUint16(10, preSkip, true);
  new DataView(h.buffer).setUint32(12, 48000, true);
  return h;
}

function webm(packets: Uint8Array[]) {
  const blocks = packets.map((p, i) => el(0xa3, Uint8Array.from([0x81, 0, i, 0x80]), p));
  return cat(
    el(0x1a45dfa3, el(0x4282, str('webm'))),
    unknown(
      0x18538067,
      el(0x1654ae6b, el(0xae, el(0xd7, Uint8Array.of(1)), el(0x86, str('A_OPUS')), el(0x63a2, opusHead(1, 312)), el(0xe1, el(0x9f, Uint8Array.of(1))))),
      unknown(0x1f43b675, el(0xe7, Uint8Array.of(0)), ...blocks),
    ),
  );
}

test('Opus packet durations from the TOC byte', () => {
  assert.equal(opusSamples(Uint8Array.of(0xf8)), 960); // CELT 20 ms, 1 frame
  assert.equal(opusSamples(Uint8Array.of(0xf9)), 1920); // 2 frames
  assert.equal(opusSamples(Uint8Array.of(0xfb, 0x03)), 2880); // code 3, 3 frames
  assert.equal(opusSamples(Uint8Array.of(0x08)), 960); // SILK 20 ms
  assert.equal(opusSamples(Uint8Array.of(0x18)), 2880); // SILK 60 ms
  assert.equal(opusSamples(Uint8Array.of(0x80)), 120); // CELT 2.5 ms
});

test('WebM/Opus (unknown-size segment and cluster) remuxed to valid Ogg/Opus', () => {
  const packets = Array.from({ length: 120 }, (_, i) => cat(Uint8Array.of(0xf8), new Uint8Array(i % 7 === 0 ? 300 : 60).fill(i)));
  const parsed = parseWebmOpus(webm(packets))!;
  assert.ok(parsed);
  assert.equal(parsed.packets.length, 120);
  assert.equal(parsed.preSkip, 312);
  const { bytes, duration } = toOggOpus(parsed);
  assert.equal(duration, 120 * 0.02);
  // Walk the pages: capture pattern, CRC, flags, sequence, granule, packet reassembly.
  let at = 0;
  let seq = 0;
  const got: Uint8Array[] = [];
  let cur: number[] = [];
  let lastGranule = 0;
  let flagsSeen: number[] = [];
  while (at < bytes.length) {
    const v = new DataView(bytes.buffer, bytes.byteOffset + at);
    assert.equal(new TextDecoder().decode(bytes.subarray(at, at + 4)), 'OggS');
    const n = bytes[at + 26]!;
    const lacing = bytes.subarray(at + 27, at + 27 + n);
    const len = 27 + n + lacing.reduce((s, x) => s + x, 0);
    const pg = bytes.slice(at, at + len);
    const crc = new DataView(pg.buffer).getUint32(22, true);
    new DataView(pg.buffer).setUint32(22, 0, true);
    assert.equal(oggCrc(pg), crc, `crc page ${seq}`);
    assert.equal(v.getUint32(18, true), seq++);
    flagsSeen.push(bytes[at + 5]!);
    lastGranule = v.getUint32(6, true);
    let p = at + 27 + n;
    for (const l of lacing) {
      cur.push(...bytes.subarray(p, p + l));
      p += l;
      if (l < 255) {
        got.push(Uint8Array.from(cur));
        cur = [];
      }
    }
    at += len;
  }
  assert.equal(flagsSeen[0], 0x02, 'BOS');
  assert.equal(flagsSeen.at(-1), 0x04, 'EOS');
  assert.equal(new TextDecoder().decode(got[0]!.subarray(0, 8)), 'OpusHead');
  assert.equal(new TextDecoder().decode(got[1]!.subarray(0, 8)), 'OpusTags');
  assert.deepEqual(got.slice(2), packets);
  assert.equal(lastGranule, 312 + 120 * 960);
});

test('non-Opus or laced WebM is refused (falls back to sending WebM)', () => {
  assert.equal(parseWebmOpus(str('not a webm')), null);
  const vorbis = webm([Uint8Array.of(0xf8)]);
  const i = new TextDecoder('latin1').decode(vorbis).indexOf('A_OPUS');
  vorbis.set(str('A_VORB'), i);
  assert.equal(parseWebmOpus(vorbis), null);
});

test('mentions become Matrix pills; plain text untouched', () => {
  const m = [{ name: 'Alice B', id: '@whatsapp_123:beeper.local' }, { name: 'Al', id: '@x:y' }];
  assert.equal(withMentions('hi @Alice B and @Al!', m), 'hi [Alice B](https://matrix.to/#/@whatsapp_123:beeper.local) and [Al](https://matrix.to/#/@x:y)!');
  assert.equal(withMentions('no mention here', m), 'no mention here');
  assert.equal(withMentions('@[x] (y)', [{ name: '[x] (y)', id: '@a:b' }]), '[\\[x\\] \\(y\\)](https://matrix.to/#/@a:b)');
  assert.equal(withMentions('@Al and @Alice B', m), '[Al](https://matrix.to/#/@x:y) and [Alice B](https://matrix.to/#/@whatsapp_123:beeper.local)');
});
