// WebM (Matroska) Opus -> Ogg Opus remux, no re-encoding. Chromium's MediaRecorder only produces
// audio/webm;codecs=opus, while some networks (WhatsApp) only take voice notes as audio/ogg;codecs=opus.
// Pure functions over bytes (no DOM), unit-tested and checked with ffprobe in the E2E tests.

const ID = {
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Channels: 0x9f,
  Audio: 0xe1,
  Cluster: 0x1f43b675,
  BlockGroup: 0xa0,
  Block: 0xa1,
  SimpleBlock: 0xa3,
};
// Master elements we descend into (also when their size is "unknown", as in live recordings).
const DESCEND = new Set([ID.Segment, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);

function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; len: number; unknown: boolean } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || at + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = (first & (0xff >> len)) === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + b[at + i]!;
    if (b[at + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: allOnes };
}

/** Number of 48 kHz samples in one Opus packet (RFC 6716 §3.1). */
export function opusSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  const ms = config < 12 ? [10, 20, 40, 60][config % 4]! : config < 16 ? [10, 20][config % 2]! : [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return Math.round(frames * ms * 48);
}

export interface WebmOpus {
  head?: Uint8Array;
  channels: number;
  preSkip: number;
  packets: Uint8Array[];
}

export function parseWebmOpus(b: Uint8Array): WebmOpus | null {
  const out: WebmOpus = { channels: 1, preSkip: 312, packets: [] };
  let opus = false;
  let at = 0;
  while (at < b.length) {
    const id = vint(b, at, true);
    if (!id) break;
    const size = vint(b, at + id.len, false);
    if (!size) break;
    const start = at + id.len + size.len;
    if (DESCEND.has(id.value)) {
      at = start;
      continue;
    }
    if (size.unknown) return null;
    const end = start + size.value;
    if (end > b.length) break; // truncated tail: keep what we have
    const data = b.subarray(start, end);
    switch (id.value) {
      case ID.CodecID:
        opus = new TextDecoder().decode(data) === 'A_OPUS';
        break;
      case ID.CodecPrivate:
        out.head = data.slice();
        break;
      case ID.Channels:
        out.channels = data[0] ?? 1;
        break;
      case ID.SimpleBlock:
      case ID.Block: {
        const track = vint(data, 0, false);
        if (!track) return null;
        const flags = data[track.len + 2] ?? 0;
        if (flags & 0x06) return null; // laced blocks: not produced by MediaRecorder for audio
        out.packets.push(data.slice(track.len + 3));
        break;
      }
    }
    at = end;
  }
  if (!opus || !out.packets.length) return null;
  if (out.head && out.head.length >= 19 && new TextDecoder().decode(out.head.subarray(0, 8)) === 'OpusHead') {
    out.channels = out.head[9]!;
    out.preSkip = out.head[10]! | (out.head[11]! << 8);
  } else out.head = undefined;
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(b: Uint8Array): number {
  let crc = 0;
  for (const x of b) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ x) & 0xff]!) >>> 0;
  return crc;
}

function page(packets: Uint8Array[], granule: number, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
  v.setUint32(6, granule % 0x100000000, true);
  v.setUint32(10, Math.floor(granule / 0x100000000), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, at);
    at += p.length;
  }
  v.setUint32(22, oggCrc(out), true);
  return out;
}

/** Ogg Opus file from parsed WebM Opus; also returns the duration in seconds. */
export function toOggOpus(w: WebmOpus, serial = 0x6265_6570): { bytes: Uint8Array; duration: number } {
  const head =
    w.head ??
    (() => {
      const h = new Uint8Array(19);
      h.set(new TextEncoder().encode('OpusHead'));
      const v = new DataView(h.buffer);
      h[8] = 1;
      h[9] = w.channels;
      v.setUint16(10, w.preSkip, true);
      v.setUint32(12, 48000, true);
      return h;
    })();
  const vendor = new TextEncoder().encode('remux');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages: Uint8Array[] = [page([head], 0, serial, 0, 0x02), page([tags], 0, serial, 1, 0)];
  let granule = w.preSkip;
  let seq = 2;
  let batch: Uint8Array[] = [];
  let segs = 0;
  w.packets.forEach((p, i) => {
    const need = Math.floor(p.length / 255) + 1;
    if (segs + need > 255 || batch.length >= 50) {
      pages.push(page(batch, granule, serial, seq++, 0));
      batch = [];
      segs = 0;
    }
    batch.push(p);
    segs += need;
    granule += opusSamples(p);
    if (i === w.packets.length - 1) pages.push(page(batch, granule, serial, seq++, 0x04));
  });
  const total = pages.reduce((s, p) => s + p.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of pages) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, duration: (granule - w.preSkip) / 48000 };
}
