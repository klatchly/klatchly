// The signed-out screens (boot.tsx, Auth.tsx: sign-in and enrolment) and the "could not load" line (lazy.tsx), English:
// the reference. The only catalog of the public boot entry: everything else of the interface (server/locales/,
// client/src/locales/<chunk>/) comes with the app's code, once signed in. Its shape defines `BootMessages`; every other
// file of this folder is a language and must match it, and the folder has exactly the languages of server/locales/
// (test/i18n.test.ts): its languages are the ones the boot detects and offers.

import type { Widen } from '../../../../server/locales/en.js';

const messages = {
  unlock: 'Unlock',
  register: 'Register',
  code: 'Code',
  locked: 'Too many attempts: try again later.',
  continueWith: (label: string) => `Continue with ${label}`,
  linkWith: (label: string) => `Link a ${label} account`,
  providerUnavailable: 'The provider cannot be reached right now. Use a passkey, or try again later.',
  loadFailed: 'Could not load this screen.',
  retry: 'Retry',
  // Offline right after an update, before the new version's code could be fetched (boot.tsx).
  updatePending: 'The app was updated. Connect to the internet once to finish the update.',
};

export type BootMessages = Widen<typeof messages>;
export default messages;
