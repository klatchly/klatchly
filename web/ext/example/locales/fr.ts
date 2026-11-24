import type { ExampleAbout, ExampleMessages } from './en.js';

// French: the same keys as en.ts (`satisfies` checks them at build time, the tests at run time).

const plural = (n: number, one: string, other: string) => (new Intl.PluralRules('fr').select(n) === 'one' ? one : other);

export default {
  title: 'Exemple',
  subtitle: 'Un paquet de référence pour les auteurs',
  intro: 'Cet espace vient du paquet d’exemple (web/ext/example) : un bouton, cette page et une route du serveur.',
  serverSays: 'Le serveur dit',
  defaultGreeting: 'Bonjour de la part du paquet d’exemple.',
  calls: (n: number) => plural(n, `${n} appel à sa route depuis son démarrage`, `${n} appels à sa route depuis son démarrage`),
  startedAt: (when: string) => `Démarré ${when}`,
  refresh: 'Actualiser',
  unavailable: 'La route d’exemple n’a pas répondu.',
  tryIt: 'Dans une discussion, ouvrez le menu ✨ et choisissez « Compter les mots » : le brouillon est compté dans le navigateur.',
  menuHeading: 'Exemple',
  countWords: 'Compter les mots',
  words: (n: number) => plural(n, `${n} mot`, `${n} mots`),
  wordsAndCharacters: (words: number, characters: number) =>
    `${plural(words, `${words} mot`, `${words} mots`)}, ${plural(characters, `${characters} caractère`, `${characters} caractères`)}`,
  charactersLabel: 'Compter aussi les caractères',
  charactersHint: 'Ajoute le nombre de caractères à « Compter les mots ». Gardé sur le serveur, pour tous vos appareils.',
  saved: 'Enregistré.',
  failed: 'Échec de l’enregistrement. Réessayez.',
} satisfies ExampleMessages;

export const about = {
  name: 'Exemple',
  description: 'Un paquet de référence pour les auteurs : un espace, une action ✨ et une page de Réglages.',
} satisfies ExampleAbout;
