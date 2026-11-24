import { createContext, useContext } from 'react';
import type { MediaTarget } from './attach';
import type { ActiveAugmentation } from './registry';
import type { Chat, Message } from './types';

export type MenuMode = 'react' | 'full' | 'reactors' | 'select';

/** Per-conversation actions shared with message rows. */
export interface Conv {
  chatID: string;
  chat?: Chat;
  selfIDs: Set<string>;
  names: Map<string, string>;
  /** Our display name in this chat (self mentions). */
  selfName?: string;
  highlight?: string;
  /** The augmentations the server has on (their slots in rows and in the message menu). */
  augmentations: readonly ActiveAugmentation[];
  reply(m: Message): void;
  toggleReaction(m: Message, key: string): void;
  /** Display name of a participant: "You" for us, the chat's name for others, else the raw ID. */
  nameOf(id: string): string;
  /** Some of these IDs are not named yet: load every participant (once). */
  needNames(ids: string[]): void;
  /** key: reaction group ID (reactors sheet filtered to one pill); att: index of the attachment pressed. */
  openMenu(m: Message, at: { x: number; y: number; corner?: boolean } | null, mode: MenuMode, key?: string, link?: string, att?: number): void;
  jumpTo(id: string): void;
  editing?: string;
  startEdit(m: Message): void;
  saveEdit(m: Message, text: string): void;
  cancelEdit(): void;
  remove(m: Message): void;
  /** Open the image lightbox on this picture (gallery key, see gallery.ts); `from` gets the focus back. */
  openMedia(key: string, from: HTMLElement | null): void;
  /** Open a file attachment in the in-app viewer (PDF preview, else a card with Save / Share). */
  openFile(target: MediaTarget, from: HTMLElement | null): void;
}

export const ConvContext = createContext<Conv | null>(null);

export function useConv(): Conv {
  const c = useContext(ConvContext);
  if (!c) throw new Error('ConvContext missing');
  return c;
}

export function isMine(conv: Conv, participantID: string): boolean {
  return conv.selfIDs.has(participantID);
}
