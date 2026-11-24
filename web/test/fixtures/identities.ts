// Synthetic identities for the tests: nobody real. The tree holds no real name, Matrix ID, phone number or
// network ID (docs/tests.md, "Personal data"; test/privacy.test.ts checks it). Same people as the offline
// fakes (test/e2e/offline/beeper.mjs). Where a test checks the shape of a real-world ID, the value below has that
// shape, with made-up digits.

/** The account owner ("me"). Real Beeper IDs end in `:beeper.com`; `.local` keeps it obviously fake. */
export const SELF = { id: '@sam:beeper.local', fullName: 'Sam Example', firstName: 'Sam', username: 'sam' } as const;

/** Someone else, native Beeper (Matrix). */
export const CONTACT = { id: '@robin:beeper.local', fullName: 'Robin Test' } as const;

/**
 * A bridged member Beeper has no name for: the raw Matrix user ID `@<network>_<numeric network id>:<server>`
 * (what lands in senderName in big bridged groups). Synthetic digits; the last 4 (`0042`) are what the member
 * label shows.
 */
export const RAW_TELEGRAM_MEMBER = '@telegram_1000000042:beeper.local';
export const RAW_TELEGRAM_MEMBER_TAIL = '0042';
/** Another one, a shorter (9-digit) Telegram ID: same shape. */
export const RAW_TELEGRAM_MEMBER_2 = '@telegram_100000007:beeper.local';

/** Account IDs as the Desktop API names them: `<bridge>.<the network's own user id>`; made-up ids. */
export const TELEGRAM_ACCOUNT = 'telegram.1000000001';
/** WhatsApp: `whatsapp.<phone number, digits only>` (+1 555-0100 numbers are reserved for fiction). */
export const WHATSAPP_ACCOUNT = 'whatsapp.15550100001';

/**
 * A media key from a local bridge: `mxc://local.beeper.com/<owner's username>_<media id>`. `media` is the part
 * after the underscore.
 */
export const localMxc = (media: string) => `mxc://local.beeper.com/${SELF.username}_${media}`;
