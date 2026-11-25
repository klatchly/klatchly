import { useQuery, type QueryClient } from '@tanstack/react-query';
import { request } from './api';
import { DEFAULT_MEMBERSHIP_MODE, type ChatEventsReply, type MembershipMode } from '../../server/membership';

// How arrivals and departures show (server/chatevents.ts): for all chats (Settings → Reading) and a chat's own
// (its menu).

export const chatEventsKey = ['chat-events'] as const;
export const useChatEvents = () => useQuery({ queryKey: chatEventsKey, queryFn: () => request<ChatEventsReply>('GET', '/chat-events'), staleTime: 5 * 60_000 });

/** The mode in a chat: its own, else the one for all chats (the default until the choices are in). */
export function membershipMode(reply: ChatEventsReply | undefined, chatID: string | undefined): MembershipMode {
  return (chatID && reply?.chats[chatID]) || reply?.membership || DEFAULT_MEMBERSHIP_MODE;
}

/** Sets the mode for all chats, or one chat's (null: back to the one for all chats). */
export async function setMembershipMode(qc: QueryClient, membership: MembershipMode | null, chat?: string): Promise<void> {
  qc.setQueryData(chatEventsKey, await request<ChatEventsReply>('PUT', '/chat-events', chat ? { chat, membership } : { membership }));
}
