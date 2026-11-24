// The accounts package's strings on the launch path (client/index.tsx): its Settings entry, shown by the core
// before the package's chunk loads. By language code, English the fallback; fr has the keys of en.

export interface AccountsLaunch {
  /** The space's name (its old pages send on to Settings), and the title of its Settings page. */
  label: string;
  settings: string;
}

export const launch: Readonly<Record<string, AccountsLaunch>> = {
  en: {
    label: 'Accounts and networks',
    settings: 'Networks',
  },
  fr: {
    label: 'Comptes et réseaux',
    settings: 'Réseaux',
  },
};
