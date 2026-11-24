// The strings the core shows before the package's chunk loads (client/index.tsx, on the launch path): the sidebar
// button, the Settings entry and the ✨ tooltip line. Kept apart from en.ts/fr.ts so that the launch path does not
// carry the whole catalog. By language code, English the fallback; every language has the keys of en.

export interface ExampleLaunch {
  /** The sidebar button's label. */
  label: string;
  /** The Settings entry's title (and the page's). */
  settings: string;
  /** A line of the ✨ button's tooltip: where the text goes (nowhere: it stays in the browser). */
  hint: string;
}

export const launch: Readonly<Record<string, ExampleLaunch>> = {
  en: { label: 'Example', settings: 'Example', hint: 'Count words: counted in your browser, nothing is sent.' },
  fr: { label: 'Exemple', settings: 'Exemple', hint: 'Compter les mots : compté dans votre navigateur, rien n’est envoyé.' },
};
