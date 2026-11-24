import type { Widen } from '#core/locales/en.js';

// The example package's English catalog: the reference. Its shape defines ExampleMessages; every other language
// file of this folder must have exactly the same keys and kinds (ext/build.test.ts and test/package.test.ts check
// it). Pure data. Plurals go through Intl.PluralRules of the file's own language. The few strings shown before the
// package's chunk loads (the sidebar button, the Settings entry) are in launch.ts.

const plural = (n: number, one: string, other: string) => (new Intl.PluralRules('en').select(n) === 'one' ? one : other);

const messages = {
  title: 'Example',
  subtitle: 'A reference package for authors',
  intro: 'This space comes from the example package (web/ext/example): a button, this page and one server route.',
  serverSays: 'The server says',
  // Shown when KLATCHLY_EXAMPLE_GREETING is not set (the server sends no greeting then).
  defaultGreeting: 'Hello from the example package.',
  calls: (n: number) => plural(n, `${n} call to its route since it started`, `${n} calls to its route since it started`),
  startedAt: (when: string) => `Started ${when}`,
  refresh: 'Refresh',
  unavailable: 'The example route did not answer.',
  tryIt: 'In a chat, open the ✨ menu and pick “Count words”: it counts your draft in the browser.',
  // The ✨ menu section.
  menuHeading: 'Example',
  countWords: 'Count words',
  words: (n: number) => plural(n, `${n} word`, `${n} words`),
  wordsAndCharacters: (words: number, characters: number) =>
    `${plural(words, `${words} word`, `${words} words`)}, ${plural(characters, `${characters} character`, `${characters} characters`)}`,
  // Its Settings page.
  charactersLabel: 'Count characters too',
  charactersHint: 'Adds the number of characters to “Count words”. Kept on the server, for all your devices.',
  saved: 'Saved.',
  failed: 'Could not save. Try again.',
};

export type ExampleMessages = Widen<typeof messages>;
export default messages satisfies ExampleMessages;

/** The package's name and one-line description (Settings → Extensions; read by the server half). */
export const about = {
  name: 'Example',
  description: 'A reference package for authors: a space, a ✨ action and a Settings page.',
};
export type ExampleAbout = Widen<typeof about>;
