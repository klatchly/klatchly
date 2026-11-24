// What a package's server half may use of the core (ext/<id>/server/ imports '#core/sdk.js' and nothing else of
// it; test/boundary.test.ts holds the line). Keep it small: everything here is an API packages depend on.

export type { Env } from './context.js';
export { clientIp } from './context.js';
export { log } from './log.js';
export { pushAll, type Payload } from './push.js';
export { RateLimiter } from './ratelimit.js';
export { pick } from './i18n.js';
// Request handling shared with the core's routes: a JSON object body (else null), the id check, and the answer to
// an upstream error (its status, logged without content).
export { fail, jsonObject, validId } from './relay.js';
// The signal of the browser read a connector's call runs for (aborted once every browser waiting on it has gone), to
// pass to its upstream calls for reads (API 1.26).
export { upstreamSignal } from './inflight.js';
// Message text as the user reads it (rich bodies to plain text), for prompts and comparisons.
export { toPlainText } from './richtext.js';
// A package's state lives in the data volume next to the core's (one JSON file per need).
export { dataPath } from './config.js';
// A sensitive change (a provider's key…) needs a recent sign-in or step-up, as the sign-in settings do: the
// middleware refuses it with 403 { error: 'step_up' }; the client confirms with client/src/StepUp.tsx (API 1.3).
export { requireStepUp, stepUpState, type StepUpState } from './stepup.js';
// What an augmentation's chat reader (ModuleContext.chats) returns: types only, the reader comes at start.
export type { ChatReader, ReadAudio, ReadImage, ReadMessage, ReadRange, ReadRangeResult } from './chatread.js';
export { READ_AUDIO_MAX, READ_RANGE_MAX } from './chatread.js';
// What an 'events' augmentation gets: its stream (onEvent) and ModuleContext.actor. Types only.
export type { ChatActor, ChatEvent, ChatInfo, EventMessage } from './chatactor.js';
// What a space that shows the user's accounts reads of the sources (ModuleContext.chatSources). Types only.
export type { ChatSources, SourceAccount, SourceChat, SourceInfo } from './chatsources.js';
// What a space that sends on its own gets (ModuleContext.sender, ServerSpace.sends; 1.24). Types only.
export type { ChatSender } from './chatsender.js';
// A frame for the browsers (ModuleContext.toBrowsers).
export type { BrowserFrame } from './broadcast.js';
// Pushes withheld from a device that already sees what they are about: one chat on screen (or the app in the
// foreground), or a package's space (its id, from the client's visibility reports).
export { spaceViewedBy, suppressedFor } from './ws.js';
// A sender's label as the core shows it (raw Matrix ids become "Member ·abcd"), for prompts and push texts.
export { senderLabel } from './names.js';
export type { ModuleInfo } from './extension.js';
// A connector (connector.ts): the canonical model it converts to, the shapes it implements and gets (its feed,
// the per-browser live session), and the error that picks the browser's answer.
export {
  ConnectorError,
  type Account,
  type AccountStatus,
  type Attachment,
  type Chat,
  type ChatFlag,
  type ChatSearchQuery,
  type ConnectorShape,
  type Failure,
  type LiveSession,
  type LiveSink,
  type LoginQR,
  type MediaRef,
  type MediaTab,
  type Message,
  type NewChatCaps,
  type Page,
  type ReceiptSupport,
  type SourceEvent,
  type SourceFeed,
  type UploadOutcome,
} from './connector.js';
export type { Upstream } from './ranges.js';
// A connector that relays media on its own routes (ConnectorShape.mediaRoutes): the headers the core's relays
// set (sandbox CSP, nosniff…), the type allowlist and disposition, and Range served over a source that may
// ignore it (a 200 read and sliced, kept in a small cache).
export { contentDisposition, mediaSecurityHeaders, mediaType } from './media.js';
export { rangedRelay, RangeCache } from './ranges.js';
// The core's limits a connector applies too: the upload cap (a stream is cut beyond it), the file name and type
// checks of what an upload answers, the bounds of a group (new chats).
export { isMime, MAX_UPLOAD_BYTES, sanitizeFileName } from './upload.js';
export { MAX_GROUP, MAX_TITLE } from './newchat.js';
export type { AugmentationScope, ModuleType, PackageInfo, SpaceInfo } from './extension.js';
export {
  augmentation,
  connector,
  definePackage,
  provider,
  space,
  type AugmentationModule,
  type ConnectorModule,
  type ModuleContext,
  type ProviderModule,
  type ServerModule,
  type ServerPackage,
  type ServerSpace,
} from './registry.js';
// The agent runtime contract (1.17; RuntimeJob and the optional capabilities otherSources, jobs, readSync: 1.19; jobsControl with pauseJob / resumeJob: 1.20): a provider that runs agents, for the package that shows them.
export type {
  AgentRuntime,
  AgentRuntimeFeatures,
  ConversationItem,
  InboundMessage,
  InboundResult,
  RunApproval,
  RunEvent,
  RuntimeAgent,
  RuntimeAgentStatus,
  RuntimeConversation,
  RuntimeConversations,
  RuntimeFollowUp,
  RuntimeJob,
  RuntimeMessage,
  RuntimeRun,
  RuntimeText,
} from './agentruntime.js';
