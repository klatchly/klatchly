import type { AgentRuntime, AgentRuntimeFeatures } from '#core/sdk.js';
import { fileManifest, forRuntime, RUNTIMES, type Agent } from './manifest.js';

// The agents of this instance over their runtimes (the core's AgentRuntime contract): which runtime each agent is
// on, the runtimes found when needed (ModuleContext.provider: a runtime package may go off and on while this one
// runs), and each runtime configured once with the manifest's agents for it. The rest of the package talks to
// agents through this file and the contract only: it never knows what a runtime is underneath.

/** A runtime by its name (the manifest's `runtime`): a provider's id, or this package's own. */
export type RuntimeLookup = (name: string) => AgentRuntime | undefined;

let lookup: RuntimeLookup | undefined;
/** Runtimes given their agents since start (a runtime found again later is configured then). */
let configured = new WeakSet<AgentRuntime>();

/** Start (each module) and stop of the package, and tests. */
export function setRuntimes(l: RuntimeLookup | undefined): void {
  lookup = l;
  configured = new WeakSet();
}

/** A runtime, configured with the manifest's agents for it (no manifest: the runtime's own list). */
export function runtimeNamed(name: string): AgentRuntime | undefined {
  const rt = lookup?.(name);
  if (rt && !configured.has(rt)) {
    configured.add(rt);
    const m = fileManifest();
    rt.configure(m ? forRuntime(m, name) : null);
  }
  return rt;
}

/** The runtimes in use, in display order: the manifest's (in the order of its agents), else every known one. */
export function runtimeNames(): string[] {
  const m = fileManifest();
  const names = m ? [...new Set(m.agents.map((a) => a.runtime))] : [...RUNTIMES];
  // Agents made in Settings → Agents (llm) come on top of the manifest's.
  for (const r of RUNTIMES) if (!names.includes(r) && lookup?.(r)?.agents().length) names.push(r);
  return names;
}

/** Every agent of the runtimes that are on, in display order; an id seen twice keeps its first runtime. */
export function agentList(): Agent[] {
  const out: Agent[] = [];
  for (const name of runtimeNames()) {
    const rt = runtimeNamed(name);
    if (!rt) continue;
    for (const a of rt.agents()) if (!out.some((x) => x.id === a.id)) out.push({ ...a, runtime: name });
  }
  return out;
}

/** The same, with whether each answers (each runtime asked at once). */
export async function agentsStatus(): Promise<(Agent & { up: boolean })[]> {
  const names = runtimeNames().filter((n) => runtimeNamed(n));
  const lists = await Promise.all(names.map(async (n) => (await runtimeNamed(n)!.agentsStatus()).map((a) => ({ ...a, runtime: n }))));
  const out: (Agent & { up: boolean })[] = [];
  for (const a of lists.flat()) if (!out.some((x) => x.id === a.id)) out.push(a);
  return out;
}

/** The runtime an agent is on (undefined: no such agent, or its runtime is off). */
export function runtimeOf(agent: string): AgentRuntime | undefined {
  const a = agentList().find((x) => x.id === agent);
  return a ? runtimeNamed(a.runtime) : undefined;
}

/** An agent's runtime capabilities (none known: nothing optional). */
export const featuresOf = (agent: string): AgentRuntimeFeatures | undefined => runtimeOf(agent)?.features;

/** The runtimes that are on, with their names. */
export const liveRuntimes = (): { name: string; rt: AgentRuntime }[] =>
  runtimeNames().flatMap((name) => {
    const rt = runtimeNamed(name);
    return rt ? [{ name, rt }] : [];
  });

/** The agent where messages for nobody in particular go: a runtime's main agent, if one is in the list. */
export function mainAgent(): string | null {
  const ids = agentList().map((a) => a.id);
  for (const { rt } of liveRuntimes()) if (rt.features.mainAgent && ids.includes(rt.features.mainAgent)) return rt.features.mainAgent;
  return null;
}

/** An error as the runtimes throw them: a numeric `status`. */
export const statusError = (status: number) => Object.assign(new Error(`agents ${status}`), { status });
