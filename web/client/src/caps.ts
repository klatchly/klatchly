import type { Chat, ChatCapabilities, Message, SupportLevel } from './types';
import { acceptsFiles, attachmentPlanFor, type AttachmentPlan } from '../../server/attachplan';
import { chatConnector } from './connectors';
import type { ComposerNetwork } from './extension';

// Chat capabilities as the chat's connector reports them (the canonical model's: the Desktop API's shapes). A chat
// that reports none at all (e.g. a native Matrix chat): an empty object means "no restrictions known", otherwise a
// feature needs level >= 1.

function caps(chat: Chat | undefined): ChatCapabilities | undefined {
  const c = chat?.capabilities;
  return c && Object.keys(c).length > 0 ? c : undefined;
}

const level = (v: SupportLevel | undefined) => (v ?? 0) >= 1;
const ageSeconds = (m: Message) => (Date.now() - new Date(m.timestamp).getTime()) / 1000;

export function canReply(chat: Chat | undefined): boolean {
  if (!chat || chat.isReadOnly) return false;
  const c = caps(chat);
  return !c || level(c.reply);
}

export function canReact(chat: Chat | undefined): boolean {
  if (!chat || chat.isReadOnly) return false;
  const c = caps(chat);
  return !c || level(c.reaction);
}

/** Emoji the network accepts, or undefined when any emoji is allowed. */
export function allowedReactions(chat: Chat | undefined): string[] | undefined {
  const list = caps(chat)?.allowedReactions;
  return list?.length ? list : undefined;
}

/** Messages that carry a real server ID (not pending) and were sent by us. */
function ownFinal(m: Message): boolean {
  return !!m.isSender && !m.isDeleted && m.sendStatus?.status !== 'PENDING' && !m.sendStatus?.status?.startsWith('FAIL');
}

export function canEdit(chat: Chat | undefined, m: Message): boolean {
  if (!chat || chat.isReadOnly || !ownFinal(m) || m.attachments?.length || !m.text) return false;
  if (m.type && m.type !== 'TEXT') return false;
  const c = caps(chat);
  if (!c) return true;
  if (!level(c.edit)) return false;
  return !c.editMaxAge || ageSeconds(m) < c.editMaxAge;
}

export function canDelete(chat: Chat | undefined, m: Message): boolean {
  if (!chat || chat.isReadOnly || !ownFinal(m)) return false;
  const c = caps(chat);
  if (!c) return true;
  if (!level(c.delete)) return false;
  return !c.deleteMaxAge || ageSeconds(m) < c.deleteMaxAge;
}

/**
 * @mentions (the canonical model's user links, matrix.to pills: mentions.ts): chats without restrictions known, or
 * networks that convert user links.
 */
export function canMention(chat: Chat | undefined): boolean {
  if (!chat || chat.isReadOnly) return false;
  const c = caps(chat);
  return !c || level(c.formatting?.user_link);
}

export function canArchive(chat: Chat | undefined): boolean {
  return caps(chat)?.archive !== false;
}

/** The low-priority inbox: chats of a connector that keeps one (connectors.ts ConnectorUI.lowPriority); no connector: none. */
export function canLowPriority(chat: Chat | undefined): boolean {
  const k = chatConnector(chat?.id);
  return !!chat && !!k && k.lowPriority !== false;
}

/** False when the network accepts no files at all (an empty attachment list). */
export function canAttach(chat: Chat | undefined): boolean {
  return acceptsFiles(chat?.capabilities);
}

export type { AttachmentPlan };

export function attachmentPlan(chat: Chat | undefined, mime: string, size: number): AttachmentPlan {
  return attachmentPlanFor(chat?.capabilities, mime, size);
}

// What a network's app really shows, where its bridge says more. Instagram (seen 2026-11-11): the Meta bridge's
// *bold*, `code` and "> " show as typed, unlike on Messenger.
const SHOWN: Readonly<Record<string, Readonly<Record<string, SupportLevel>>>> = { Instagram: {} };

/**
 * Where a draft goes, for the ✨ rewrites (ComposerApi.network): the network and the formatting it displays. A
 * chat that lists no formatting displays none (LINE's bridge sends the raw text: "**" would show), unless its
 * connector says such chats display Markdown (ConnectorTraits.displaysMarkdown, e.g. native Matrix chats): left unset.
 */
export function chatNetwork(chat: Chat | undefined): ComposerNetwork | undefined {
  if (!chat) return undefined;
  const formatting = SHOWN[chat.network] ?? chat.capabilities?.formatting ?? (chatConnector(chat.id)?.displaysMarkdown?.(chat) ? undefined : {});
  return { name: chat.network, ...(formatting ? { formatting } : {}) };
}
