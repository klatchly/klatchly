import type { WritingAbout, WritingMessages, WritingUses } from './en.js';

export default {
  assist: {
    fix: 'Corriger',
    spelling: 'Orthographe seulement',
    grammar: 'Orthographe et grammaire',
    rephrase: 'Améliorer la formulation',
    translateTo: 'Traduire en',
    settings: 'Réglages de cette discussion…',
    chatSettings: 'Aide à l’écriture pour cette discussion',
    headSummary: (lang: string, address?: string) => `Aide à l’écriture pour cette discussion : ${lang}${address ? ` · ${address}` : ''}`,
    typeFirst: 'Écris d’abord un message pour le corriger ou le traduire.',
    defaultLang: 'Langue par défaut',
    address: 'Comment je m’adresse à cette personne',
    addressHint: 'ex. « je suis em, elle est chị », « formel, vouvoiement »',
    save: 'Enregistrer',
    working: 'En cours…',
    fixed: (what: string) => `${what} · IA`,
    original: 'Original',
    translatedFrom: (lang: string) => `Traduit en ${lang} · original ci-dessous`,
    sentOriginal: 'Ton original (visible par toi seul)',
    hideOriginal: 'Masquer l’original',
    lost: (items: string) => `Non appliqué : l’IA a perdu ${items}.`,
    failed: 'L’IA n’a pas pu répondre. Réessaie.',
    tooLong: 'Trop long pour l’IA (4000 caractères au plus).',
    quick: 'Bouton rapide (à côté de ✨)',
    quickNone: 'Aucun',
    defaultChoice: (what: string) => `Par défaut (${what})`,
    quickTranslate: (lang: string) => `Traduire en ${lang}`,
    privacyBoth: (assist?: string, translate?: string) =>
      `Envoyé aux modèles IA : ${assist ?? 'le modèle IA'} (aide à l’écriture), ${translate ?? 'le modèle IA'} (traduction des messages reçus)`,
    msgQuick: 'Action rapide sur les messages',
  },
  translate: {
    label: (lang: string) => `Traduction · ${lang}`,
    loading: 'Traduction…',
    failed: 'Traduction impossible.',
    tooLong: 'Trop long pour être traduit.',
    noText: 'Pas de texte à traduire dans cette image.',
    imageTooLarge: 'Image trop lourde pour être traduite (8 Mo au plus).',
    noImage: 'Cette image ne peut pas être lue pour une traduction (JPEG, PNG, WebP ou GIF seulement).',
    reading: 'Lecture de l’image…',
    hide: 'Masquer la traduction',
  },
  menu: {
    translateTo: (lang: string) => `Traduire en ${lang}`,
    translateImageTo: (lang: string) => `Traduire l’image en ${lang}`,
  },
  settings: {
    langsHint:
      'Les langues proposées pour traduire, dans toutes les discussions. Une discussion retient la dernière langue dans laquelle tu as traduit ; choisis « Par défaut » dans ses réglages ✨ pour suivre à nouveau cette liste.',
    langsDraft: 'Traduire mes messages en',
    langsRead: 'Traduire les messages reçus en',
    langsMax: (n: number) => `Jusqu’à ${n}. La première est celle par défaut.`,
    langsDefault: 'par défaut',
    langsAdd: '+ Ajouter',
    langsAddLabel: 'Ajouter une langue',
    langsRemove: (lang: string) => `Retirer : ${lang}`,
    langsUp: (lang: string) => `Monter : ${lang}`,
    langsSaved: 'Enregistré.',
  },
} satisfies WritingMessages;

export const about = {
  name: 'Aide à l’écriture',
  description: 'Corrige et traduit vos brouillons, traduit les messages reçus, quand vous le demandez.',
} satisfies WritingAbout;

export const uses = {
  translate: 'Traduction des messages reçus',
  assist: 'Aide à l’écriture (corrections et traduction du brouillon)',
  image: 'Traduction des images (un modèle qui lit les images)',
} satisfies WritingUses;
