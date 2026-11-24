import { augmentation, definePackage, space, type AgentRuntime, type ModuleContext } from '#core/sdk.js';
import type { LlmProvider } from '#ext/llm/api.js';
import { agentsPackage, chatAgentModule, agentsSpace } from '../package.js';
import { agentsAbout } from '../locales/index.js';
import { chatAgentRoutes, handleChatAgentEvent, setChatAgent } from './chatagent.js';
import { llmRuntime, setLlm } from './llmruntime.js';
import { LLM_RUNTIME, loadManifest } from './manifest.js';
import { setRuntimes } from './runtimes.js';
import { ensureMigrated, listen, setSpace, spaceRoutes, spaceShown } from './space.js';

// The agents package's server half: the Agents space (/api/agents/*) and the agent inside a chat (/api/chatagent/*,
// the stream of new messages). Both reach agents through their
// runtimes (the core's AgentRuntime contract, runtimes.ts): the providers of the packages this one enhances,
// found by the name the manifest gives (`runtime`), and its own runtime on llm (llmruntime.ts). Which agents
// exist, and what is shown and said about them: the manifest (KLATCHLY_AGENTS_FILE, manifest.ts), else each runtime's
// own list, plus the agents made in Settings → Agents (llm).

/** The runtimes, looked up when needed (a runtime's package may go off and on while this one runs). */
function useRuntimes(ctx: ModuleContext): void {
  const llm = () => ctx.provider<LlmProvider>('llm');
  setLlm(llm);
  setRuntimes((name) => (name === LLM_RUNTIME ? (llm() ? llmRuntime : undefined) : ctx.provider<AgentRuntime>(name)));
}

export default definePackage({
  ...agentsPackage,
  about: agentsAbout,
  modules: [
    space({
      ...agentsSpace,
      routes: spaceRoutes,
      // Only while a runtime that keeps conversations is on (Hermes today): no button, no page, no route otherwise.
      shown: () => spaceShown(),
      // A manifest that cannot be read or is invalid turns the package off, with the field at fault as the reason
      // (Settings → Extensions, the log): no agent is guessed.
      check: () => {
        try {
          loadManifest();
          return null;
        } catch (e) {
          return (e as Error).message;
        }
      },
      start: (ctx) => {
        loadManifest();
        // data/hermes.json (before 3.0) -> data/agents-space.json, before anything reads it.
        ensureMigrated();
        useRuntimes(ctx);
        setSpace(true, ctx.toBrowsers, ctx.push);
      },
      stop: () => setSpace(false),
      logPath: (p) =>
        p
          .replace(/^\/api\/agents\/sessions\/[^/]+/, '/api/agents/sessions/:id')
          .replace(/^\/api\/agents\/runs\/[^/]+/, '/api/agents/runs/:key')
          .replace(/^\/api\/agents\/jobs\/[^/]+/, '/api/agents/jobs/:id'),
    }),
    augmentation({
      ...chatAgentModule,
      routes: chatAgentRoutes,
      onEvent: (ev) => handleChatAgentEvent(ev),
      start: (ctx) => {
        if (!ctx.actor) throw new Error('no chat actor');
        useRuntimes(ctx);
        setChatAgent(true, ctx.actor, ctx.toBrowsers, ctx.push, ctx.chats);
        // The space started first: the runtimes are reachable now, so it can take what their agents post.
        listen();
      },
      stop: () => {
        setChatAgent(false);
        setLlm(undefined);
        setRuntimes(undefined);
      },
      logPath: (p) => p.replace(/^\/api\/chatagent\/drafts\/[^/]+/, '/api/chatagent/drafts/:id'),
    }),
  ],
});
