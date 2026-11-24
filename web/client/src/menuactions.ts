// Which actions the message menu offers, in order. Pure (unit-tested in test/menuactions.test.ts): the menu
// maps each id to its label and handler, and draws the augmentations' entries (MessageMenuSlotProps,
// extension.ts) where 'augment-top' and 'augment' stand.

export type MediaKindForMenu = 'image' | 'gif' | 'video' | 'audio' | 'file';

export type MenuActionID =
  | 'open'
  | 'save'
  | 'copy-image'
  | 'reply'
  | 'forward'
  | 'copy-link'
  | 'copy'
  | 'select'
  | 'augment-top'
  | 'augment'
  | 'reactions';

export interface MenuInput {
  deleted: boolean;
  canReply: boolean;
  /** The message has text (a caption, for media): text actions only then. */
  hasText: boolean;
  /** A link was under the pointer / finger. */
  link: boolean;
  /** Desktop popover at the pointer; false for the touch sheet. */
  anchored: boolean;
  /** An active augmentation has entries for the menu of a message with text, or of a picture (1.9.0). */
  augmented: boolean;
  /** An active augmentation has entries for the menu of an audio attachment (AugmentationUI.audioMenu, 1.23.0). */
  augmentedAudio?: boolean;
  hasReactions: boolean;
  /** The attachment the menu is about (the one pressed, else the message's first). */
  media?: { kind: MediaKindForMenu; openable: boolean };
  canCopyImage: boolean;
  /** Sent, not deleted, with text or a file (forward.ts canForward). */
  canForward?: boolean;
}

export function menuActions(i: MenuInput): MenuActionID[] {
  const out: MenuActionID[] = [];
  if (i.media && !i.deleted) {
    if (i.media.openable) out.push('open');
    out.push('save');
    if (i.media.kind === 'image' && i.canCopyImage) out.push('copy-image');
  }
  if (i.canReply && !i.deleted) out.push('reply');
  if (i.canForward && !i.deleted) out.push('forward');
  if (i.link) out.push('copy-link');
  const text = i.hasText && !i.deleted;
  if (text) out.push('copy');
  // Touch: bubbles are not selectable (long-press opens this menu), so part of a text is copied from here.
  if (text && !i.anchored) out.push('select');
  const picture = (i.media?.kind === 'image' || i.media?.kind === 'gif') && !i.deleted;
  const audio = i.media?.kind === 'audio' && !i.deleted;
  if ((i.augmented && (text || picture)) || (i.augmentedAudio && audio)) {
    out.push('augment');
    // Touch has no hover row: an augmentation's one-tap action heads the sheet of a text message instead.
    if (!i.anchored && !i.media) out.unshift('augment-top');
  }
  if (i.hasReactions) out.push('reactions');
  return out;
}
