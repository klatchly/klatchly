export interface Participant {
  id: string;
  fullName?: string;
  username?: string;
  imgURL?: string;
  isSelf?: boolean;
}

export interface Attachment {
  id?: string;
  type: 'unknown' | 'img' | 'video' | 'audio';
  srcURL?: string;
  mimeType?: string;
  fileName?: string;
  fileSize?: number;
  isGif?: boolean;
  isSticker?: boolean;
  isVoiceNote?: boolean;
  duration?: number;
  posterImg?: string;
  size?: { width?: number; height?: number };
}

export interface Reaction {
  id: string;
  reactionKey: string;
  participantID: string;
  emoji?: boolean;
  imgURL?: string;
}

export interface Message {
  id: string;
  chatID: string;
  accountID: string;
  senderID: string;
  senderName?: string;
  timestamp: string;
  sortKey: string;
  type?: string;
  text?: string;
  editedTimestamp?: string;
  isSender?: boolean;
  isDeleted?: boolean;
  isHidden?: boolean;
  attachments?: Attachment[];
  reactions?: Reaction[];
  sendStatus?: { status: string };
  linkedMessageID?: string;
  links?: LinkPreviewInfo[];
  mentions?: string[] | null;
  /** Read receipts: participant ID → when they read up to this message (only their latest position). */
  seen?: Record<string, string>;
  /**
   * Delivery receipts, same shape: participant ID → when the latest message delivered to them arrived. Some
   * connectors carry them; for Beeper networks (WhatsApp 1:1) the server infers them live.
   */
  delivered?: Record<string, string>;
}

export interface LinkPreviewInfo {
  url: string;
  originalURL?: string;
  title?: string;
  summary?: string;
  img?: string;
  imgSize?: { width?: number; height?: number };
}

export interface Preview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
}

export interface Chat {
  id: string;
  accountID: string;
  network: string;
  title: string;
  type: 'single' | 'group';
  imgURL?: string;
  participants?: { items: Participant[]; hasMore: boolean; total: number };
  preview?: Message;
  unreadCount: number;
  isPinned?: boolean;
  isMuted?: boolean;
  isArchived?: boolean;
  isLowPriority?: boolean;
  lastActivity?: string;
  isReadOnly?: boolean;
  capabilities?: ChatCapabilities;
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
  oldestCursor: string | null;
  newestCursor: string | null;
}

export interface UploadResult {
  uploadID: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  duration?: number;
}

export type SupportLevel = -2 | -1 | 0 | 1 | 2;

export interface ChatCapabilities {
  attachments?: Record<string, { mimeTypes?: Record<string, SupportLevel>; caption?: SupportLevel; maxSize?: number }>;
  maxTextLength?: number;
  reply?: SupportLevel;
  edit?: SupportLevel;
  editMaxAge?: number;
  delete?: SupportLevel;
  deleteMaxAge?: number;
  deleteForMe?: boolean;
  reaction?: SupportLevel;
  reactionCount?: number;
  allowedReactions?: string[];
  customEmojiReactions?: boolean;
  archive?: boolean;
  formatting?: Record<string, SupportLevel>;
}

export interface Account {
  accountID: string;
  network: string;
}

/** A person found on an account (Desktop API User, fields cleaned by the server). */
export interface Contact {
  id: string;
  username?: string;
  phoneNumber?: string;
  email?: string;
  fullName?: string;
  imgURL?: string;
  cannotMessage?: boolean;
  isSelf?: boolean;
  /** One already has a conversation with them on this account. */
  inChats?: boolean;
  /** Their direct chat on this account: opened as it is (starting one could send a message). */
  chatID?: string;
}

/** What an account allows when starting a conversation (server/newchat.ts summarize). */
export interface NewChatCaps {
  accountID: string;
  network: string;
  connected: boolean;
  start: boolean;
  lookup: { phone: boolean; email: boolean; username: boolean };
  contactList: boolean;
  group: null | { nameAllowed: boolean; nameRequired: boolean; nameMax: number; min: number; max: number };
  existingOnly?: boolean;
}
