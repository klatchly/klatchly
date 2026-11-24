import type { ModuleType } from '../../../../server/extension.js';
import type { Widen } from '../../../../server/locales/en.js';

// Settings → Extensions (Extensions.tsx, its own chunk), English: the reference. Its shape defines
// `ExtensionsMessages`; every other file of this folder is a language (its file name the code, as in
// server/locales/) and must match it; a language without a file here falls back to English.

const plural = (n: number, one: string, other: string) => (new Intl.PluralRules('en').select(n) === 'one' ? one : other);

const messages = {
  intro: 'Parts of Klatchly that can be turned off. A change applies at once, on every device signed in to this server.',
  api: (v: string) => `Extension API ${v}`,
  type: { connector: 'connector', space: 'space', augmentation: 'augmentation', provider: 'provider' } satisfies Record<ModuleType, string>,
  events: 'reads every message of your chats',
  onDemand: 'only when you ask',
  chatSources: 'reads your accounts, the titles and figures of your chats (never a message)',
  sends: 'sends messages in your name (what you share to it)',
  bearer: 'answers devices that hold a token of its own',
  // Its declared capabilities (PackageInfo network / listen / files / spawns): variables are named, never their values.
  network: (to: string) => `Connects to: ${to}`,
  noNetwork: 'No connection of its own',
  anyAddress: 'addresses given at run time',
  listen: (at: string) => `Listens on: ${at}`,
  files: (what: string) => `Files: ${what}`,
  dataFiles: 'its own data',
  spawns: 'Starts other programs',
  on: 'On',
  disabled: 'Turned off',
  off: (why: string) => `Off: ${why}`,
  version: (v: string) => `Version ${v}`,
  apiNeed: (range: string, ok: boolean, present: string) => (ok ? `extension API ${range} ✓` : `needs extension API ${range}, this server has ${present}`),
  requires: 'Requires',
  enhances: 'Works better with',
  requiredBy: 'Required by',
  dep: (name: string, range: string, ok: boolean, present?: string) =>
    ok ? `${name} ${range} ✓` : present ? `${name} ${range}: version ${present} here` : `${name} ${range}: not installed`,
  cause: {
    disabled: 'turned off in Settings',
    config: (vars: string) => `missing configuration ${vars}`,
    check: (detail: string) => `not ready (${detail})`,
    api: (range: string, present: string) => `needs extension API ${range}, this server has ${present}`,
    missing: (name: string) => `needs ${name}, missing on this server`,
    version: (name: string, range: string, present: string) => `needs ${name} ${range}, version ${present} here`,
    reqOff: (name: string) => `needs ${name}, which is off`,
    reqDisabled: (name: string) => `needs ${name}, which is turned off`,
    cycle: 'its dependencies loop',
    start: (module: string) => `failed to start (${module})`,
  },
  keepDefault: 'The default chat source: Klatchly cannot run without it.',
  keepLast: 'The last chat source on: Klatchly cannot run without one.',
  cannot: 'Cannot run on this server.',
  turnOff: (name: string) => `Turn ${name} off`,
  turnOn: (name: string) => `Turn ${name} on`,
  confirmOff: (name: string, others: string) => `Turning ${name} off also turns off: ${others}.`,
  confirmOn: (name: string, others: string) => `To turn ${name} on, ${others} must be on too.`,
  offAll: 'Turn off',
  onBoth: 'Turn on both',
  onAll: 'Turn all on',
  stillOff: (others: string, n: number) => plural(n, `Still turned off: ${others}. Turn it on too?`, `Still turned off: ${others}. Turn them on too?`),
  onToo: 'Turn on',
  noThanks: 'Not now',
  retry: 'Try again',
  failed: 'That did not work. Try again.',
  loading: 'Loading…',
};

export type ExtensionsMessages = Widen<typeof messages>;
export default messages satisfies ExtensionsMessages;
