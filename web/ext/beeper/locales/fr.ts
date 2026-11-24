import type { BeeperAbout, BeeperMatrix } from './en.js';

export const about = {
  name: 'Beeper (API Desktop)',
  description: 'Vos discussions par l’API Beeper Desktop (Beeper Server ou l’app Desktop) : la source par défaut.',
} satisfies BeeperAbout;

export const discreetNote =
  'Lue discrètement, une discussion reste non lue dans les autres apps Beeper. Répondre marque tous ses messages précédents comme lus.';

export const matrix = {
  joinOpen: 'Rejoindre un salon Matrix',
  joinField: 'Adresse du salon ou lien matrix.to',
  joinPlaceholder: '#salon:serveur ou un lien matrix.to',
  join: 'Rejoindre',
  joining: 'Un instant…',
  joinHint: 'Vous rejoignez avec votre compte Beeper : les membres du salon le voient. Un salon rejoint est mis en sourdine.',
  badTarget: 'Ce n’est pas une adresse de salon. Utilisez #salon:serveur, !id:serveur ou un lien matrix.to.',
  notReady: 'Salon rejoint. Il apparaît dans vos discussions dans un instant.',
  errForbidden: 'Ce salon est sur invitation, ou vous en êtes banni.',
  errNotFound: 'Aucun salon n’a cette adresse.',
  errRate: 'Trop de tentatives. Réessayez dans quelques minutes.',
  errUnavailable: 'Ce serveur Beeper ne permet pas à Klatchly de rejoindre des salons. Rejoignez-le depuis une app Beeper : il apparaîtra ensuite ici.',
  errRefused: 'Le serveur a refusé de rejoindre ce salon.',
  errGeneric: 'Impossible de rejoindre le salon. Réessayez.',
  linkTitle: 'Salon Matrix',
  linkBody: (room: string) => `Rejoindre ${room} avec votre compte Beeper ? Ses membres verront que vous l’avez rejoint. Il sera mis en sourdine.`,
  linkBodyId: 'Rejoindre ce salon Matrix avec votre compte Beeper ? Ses membres verront que vous l’avez rejoint. Il sera mis en sourdine.',
  linkChecking: 'Vérification…',
  linkBrowser: 'Ouvrir dans le navigateur',
  leave: 'Quitter le salon',
  leaveTitle: (title: string) => `Quitter ${title} ?`,
  leaveBody: 'Vous quittez ce salon Matrix sur tous vos appareils. Pour revenir, il faudra le rejoindre à nouveau (ou y être invité).',
  leaving: 'Départ…',
  left: 'Salon quitté',
  errLeave: 'Impossible de quitter le salon. Réessayez.',
  errLeaveUnavailable: 'Ce serveur Beeper ne permet pas à Klatchly de quitter des salons. Quittez-le depuis une app Beeper.',
} satisfies BeeperMatrix;
