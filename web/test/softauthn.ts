import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

// A software WebAuthn authenticator for the tests (a platform passkey with user verification, attestation "none"):
// it answers the server's real options with responses @simplewebauthn/server verifies like a browser's, so that
// the sign-in, enrollment and step-up routes run end to end. Every field can be bent to test a refusal.

type Cbor = number | string | Uint8Array | Map<number | string, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** The CBOR subset WebAuthn needs: integers, byte and text strings, maps. */
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest();

export interface Bend {
  origin?: string;
  rpID?: string;
  type?: string;
  challenge?: string;
  counter?: number;
  userHandle?: string;
  /** Flags byte (UP 0x01, UV 0x04, AT 0x40). */
  flags?: number;
}

export class SoftAuthenticator {
  readonly id = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Buffer;
  counter = 0;

  constructor(
    readonly origin: string,
    readonly rpID: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  get credentialId(): string {
    return b64(this.id);
  }

  private authData(rpID: string, flags: number, counter: number, attested: boolean): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    const parts: Buffer[] = [sha(rpID), Buffer.from([flags]), c];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), len, this.id, this.cose);
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create() on the server's registration options. */
  register(options: { challenge: string }, bend: Bend = {}) {
    const clientDataJSON = this.clientData(bend.type ?? 'webauthn.create', bend.challenge ?? options.challenge, bend.origin ?? this.origin);
    const authData = this.authData(bend.rpID ?? this.rpID, bend.flags ?? 0x45, bend.counter ?? this.counter, true);
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get() on the server's assertion options (the counter goes up, as a real one's may). */
  assert(options: { challenge: string }, userHandle: string, bend: Bend = {}) {
    if (bend.counter === undefined) this.counter++;
    const clientDataJSON = this.clientData(bend.type ?? 'webauthn.get', bend.challenge ?? options.challenge, bend.origin ?? this.origin);
    const authenticatorData = this.authData(bend.rpID ?? this.rpID, bend.flags ?? 0x05, bend.counter ?? this.counter, false);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha(clientDataJSON)]), this.key);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: bend.userHandle ?? userHandle },
      clientExtensionResults: {},
    };
  }
}
