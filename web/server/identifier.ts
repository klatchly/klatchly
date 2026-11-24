// What a contact search text is: a phone number, an email address or an @username is looked up exactly
// on the network by the Desktop API; anything else only searches existing contacts. Shared by the server
// (validation of chats/start) and the client (the "exact lookup" hint). No imports: used on both sides.

export type Identifier = { kind: 'phone'; value: string } | { kind: 'email'; value: string } | { kind: 'username'; value: string };

const PHONE_CHARS = /^\+?[0-9 ().-]{6,24}$/;
export const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
/** @handle, or a Matrix ID @user:server (Beeper accounts). */
export const USERNAME = /^@[A-Za-z0-9._=+-]{1,64}(:[A-Za-z0-9.-]{1,253}(:\d{1,5})?)?$/;

/** Phone number reduced to + and digits (E.164 when it starts with +), or null. */
export function normalizePhone(v: string): string | null {
  const t = v.trim();
  if (!PHONE_CHARS.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return null;
  return (t.startsWith('+') ? '+' : '') + digits;
}

export function classifyIdentifier(text: string): Identifier | null {
  const t = text.trim();
  if (!t || t.length > 255) return null;
  const phone = normalizePhone(t);
  if (phone) return { kind: 'phone', value: phone };
  if (EMAIL.test(t)) return { kind: 'email', value: t.toLowerCase() };
  if (USERNAME.test(t)) return { kind: 'username', value: t };
  return null;
}
