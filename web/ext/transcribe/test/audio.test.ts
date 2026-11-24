import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseMime, encodeWav, extensionFor, flacInfo, mixdown, oggOpusHead, parseWav, plainPcm16, resample, silenceWav, splitWav, toInt16, toSpeechWav, wavSeconds } from '../audio.js';

// The sound formats both halves share (../audio.ts): the browser's conversion (mixdown, resample, WAV), and what the
// server checks and cuts. Pure functions: no browser needed.

test('WAV: written, read back, cut into pieces on whole frames', () => {
  const s = Int16Array.from({ length: 16_000 * 3 + 5 }, (_, i) => (i % 200) - 100);
  const wav = encodeWav(s, 16_000);
  assert.equal(wav.length, 44 + s.length * 2);
  const w = parseWav(wav)!;
  assert.deepEqual(w, { format: 1, channels: 1, rate: 16_000, bits: 16, dataOffset: 44, dataLength: s.length * 2 });
  assert.ok(plainPcm16(w));
  assert.ok(Math.abs(wavSeconds(w) - 3.0003) < 0.001);
  const pieces = splitWav(wav, w, 1);
  assert.equal(pieces.length, 4);
  const back = pieces.map((p) => parseWav(p)!);
  assert.deepEqual(back.map((x) => x.dataLength / 2), [16_000, 16_000, 16_000, 5]);
  // The samples are kept in order across the pieces.
  const v = new DataView(pieces[1]!.buffer, pieces[1]!.byteOffset);
  assert.equal(v.getInt16(44, true), s[16_000]);
  assert.deepEqual(splitWav(wav, w, 60), [wav], 'short enough: the file itself');
  // Stereo frames are never split in the middle.
  const st = encodeWav(new Int16Array(10), 2, 2);
  assert.deepEqual(splitWav(st, parseWav(st)!, 1).map((p) => parseWav(p)!.dataLength), [8, 8, 4]);
});

test('WAV: what is not one, or not plain 16-bit PCM', () => {
  assert.equal(parseWav(new Uint8Array(10)), null);
  assert.equal(parseWav(new TextEncoder().encode('RIFF....WAVEjunk' + ' '.repeat(40))), null);
  const f = encodeWav(new Int16Array(4), 16_000);
  f[20] = 3; // IEEE float
  assert.equal(plainPcm16(parseWav(f)!), false);
  // A streamed WAV whose data size says 0: the rest of the file.
  const z = encodeWav(new Int16Array(8), 8000);
  new DataView(z.buffer).setUint32(40, 0, true);
  assert.equal(parseWav(z)!.dataLength, 16);
  assert.equal(parseWav(silenceWav(1))!.dataLength, 32_000);
});

test('conversion: channels averaged, rates changed (box filter down, linear up), clipped to 16 bits', () => {
  assert.deepEqual([...mixdown([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0, 1, 9])])], [0.5, 0, 0]);
  const one = Float32Array.from([0.25]);
  assert.equal(mixdown([one]), one);
  const down = resample(Float32Array.from([1, 1, 1, 0, 0, 0]), 48_000, 16_000);
  assert.deepEqual([...down], [1, 0]);
  const up = resample(Float32Array.from([0, 1]), 8000, 16_000);
  assert.deepEqual([...up], [0, 0.5, 1, 1]);
  assert.equal(resample(one, 16_000, 16_000), one);
  assert.equal(resample(new Float32Array(44_100), 44_100, 16_000).length, 16_000);
  assert.deepEqual([...toInt16(Float32Array.from([2, -2, 0, 0.5]))], [32767, -32768, 0, 16384]);
  const wav = toSpeechWav([new Float32Array(48_000), new Float32Array(48_000)], 48_000);
  const w = parseWav(wav)!;
  assert.deepEqual([w.channels, w.rate, w.bits, w.dataLength], [1, 16_000, 16, 32_000]);
});

test('Ogg Opus and FLAC headers; types and file names', () => {
  // An Ogg page with one segment holding OpusHead (version 1, 2 channels, pre-skip, 16 kHz input).
  const head = new Uint8Array(27 + 1 + 19);
  head.set(new TextEncoder().encode('OggS'), 0);
  head[26] = 1;
  head[27] = 19;
  head.set(new TextEncoder().encode('OpusHead'), 28);
  head[36] = 1;
  head[37] = 2;
  new DataView(head.buffer).setUint32(40, 16_000, true);
  assert.deepEqual(oggOpusHead(head), { channels: 2, inputRate: 16_000 });
  const vorbis = head.slice();
  vorbis.set(new TextEncoder().encode('\x01vorbis\x00'), 28);
  assert.equal(oggOpusHead(vorbis), null, 'Ogg Vorbis is not Opus');
  assert.equal(oggOpusHead(new Uint8Array(60)), null);

  const flac = new Uint8Array(42);
  flac.set(new TextEncoder().encode('fLaC'), 0);
  // STREAMINFO: rate 44100 (0x0AC44) on 20 bits, 2 channels.
  flac[18] = 0x0a;
  flac[19] = 0xc4;
  flac[20] = 0x42;
  assert.deepEqual(flacInfo(flac), { rate: 44_100, channels: 2 });
  assert.equal(flacInfo(new Uint8Array(42)), null);

  assert.equal(baseMime('Audio/OGG; codecs=opus'), 'audio/ogg');
  assert.equal(extensionFor('audio/x-m4a'), 'm4a');
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg');
  // Every WAV and Ogg type the engine sends to an OpenAI-compatible server as is (it guesses the format from the name).
  assert.equal(extensionFor('audio/vnd.wave'), 'wav');
  assert.equal(extensionFor('application/ogg'), 'ogg');
  assert.equal(extensionFor('audio/x-caf'), undefined);
});
