import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './endpoints';
import { findChat, keys } from './cache';

// A chat's title and network for a package's component in a conversation (its header chip, a panel): read from
// the conversation's own query (same key, so no extra request while the chat is open). Since API 1.21.

export interface ChatSummary {
  title: string;
  network: string;
}

/** The chat's title and network, undefined while unknown. */
export function useChatSummary(chatID: string): ChatSummary | undefined {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: keys.chat(chatID), queryFn: () => api.chat(chatID), placeholderData: () => findChat(qc, chatID), staleTime: 60_000 });
  const c = q.data;
  return c ? { title: c.title ?? '', network: c.network ?? '' } : undefined;
}
