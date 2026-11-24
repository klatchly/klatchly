import { createECDH, createPublicKey, createDecipheriv, hkdfSync, randomBytes, verify } from 'node:crypto';

/** A fake browser: P-256 key pair + auth secret, able to decrypt aes128gcm push bodies (RFC 8291). */
export function fakeBrowser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const p256dh = ecdh.getPublicKey();
  return {
    keys: { p256dh: p256dh.toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const rs = body.readUInt32BE(16);
      const idlen = body[20]!;
      const asPublic = body.subarray(21, 21 + idlen);
      const ct = body.subarray(21 + idlen);
      if (rs < 18 || ct.length > rs) throw new Error('bad record size');
      const secret = ecdh.computeSecret(asPublic);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, asPublic]);
      const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
      const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const d = createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      if (plain[end] !== 2) throw new Error('bad padding delimiter');
      return plain.subarray(0, end).toString('utf8');
    },
  };
}

/** Verifies "vapid t=<jwt>, k=<key>" (RFC 8292): ES256 signature, audience, expiry. Returns the claims. */
export function verifyVapid(header: string, endpoint: string, expectedKey: string): Record<string, unknown> {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header);
  if (!m) throw new Error('bad Authorization header');
  const [h64, p64, s64] = m[1]!.split('.');
  if (m[2] !== expectedKey) throw new Error('wrong VAPID public key');
  const raw = Buffer.from(m[2]!, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33, 65).toString('base64url') },
    format: 'jwk',
  });
  const ok = verify('sha256', Buffer.from(`${h64}.${p64}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64!, 'base64url'));
  if (!ok) throw new Error('bad JWT signature');
  const header0 = JSON.parse(Buffer.from(h64!, 'base64url').toString());
  if (header0.alg !== 'ES256') throw new Error('alg');
  const claims = JSON.parse(Buffer.from(p64!, 'base64url').toString()) as Record<string, unknown>;
  if (claims.aud !== new URL(endpoint).origin) throw new Error('aud');
  const exp = claims.exp as number;
  if (!(exp > Date.now() / 1000 && exp <= Date.now() / 1000 + 24 * 3600)) throw new Error('exp');
  return claims;
}
