import type { BootMessages } from './en.js';

const messages: BootMessages = {
  unlock: 'Déverrouiller',
  register: 'Enregistrer',
  code: 'Code',
  locked: 'Trop d’essais : réessayez plus tard.',
  continueWith: (label: string) => `Continuer avec ${label}`,
  linkWith: (label: string) => `Lier un compte ${label}`,
  providerUnavailable: 'Le fournisseur est injoignable pour le moment. Utilisez une passkey, ou réessayez plus tard.',
  loadFailed: 'Impossible de charger cet écran.',
  retry: 'Réessayer',
  updatePending: 'L’app a été mise à jour. Connectez-vous à Internet une fois pour terminer la mise à jour.',
};

export default messages;
