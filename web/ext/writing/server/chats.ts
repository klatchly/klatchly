import type { ChatReader } from '#core/sdk.js';

// The chat reader the core hands writing at start (ModuleContext.chats): what translate.ts and assist.ts read,
// on demand, logged with the package id. Undefined before start and after stop (the routes answer 503 then).

let reader: ChatReader | undefined;
export function setChats(r: ChatReader | undefined): void {
  reader = r;
}
export const chats = (): ChatReader | undefined => reader;
