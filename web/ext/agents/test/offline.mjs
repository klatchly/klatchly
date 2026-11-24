// The agents package on the offline instance (test/e2e/offline/server.mjs, which starts the fake of every listed
// package that has a test/offline.mjs). It has no service of its own: it reaches agents through their runtimes.
// With the hermes package in the build, its fake (ext/hermes/test/offline.mjs: profiles default, assistant,
// archives without a key, chat) is the runtime, and the manifest (KLATCHLY_AGENTS_FILE) names those profiles with what
// the host declares about each one. Without it there is no manifest and no Agents space: the runtime on llm (whose
// fake is ext/llm/test/offline.mjs) has only the agents a script makes in Settings → Agents (LLM) (llmagent.e2e.cjs),
// cleared before each script (so llm's Default models page lists the same uses as in a build without agents).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtPackages } from '../../../test/e2e/offline/packages.mjs';

const DISCLOSURE = { en: 'offline runtime', fr: 'runtime hors ligne' };
const HERMES = {
  version: 1,
  chatDefault: 'chat',
  agents: [
    {
      id: 'default',
      label: 'Hermes',
      description: 'Généraliste : questions, recherches et petites tâches sur le serveur.',
      helpers: ['assistant'],
      access: 'full',
      accessNote: { en: 'files, code, browser, connections…', fr: 'fichiers, code, navigateur, connexions…' },
      disclosure: DISCLOSURE,
    },
    { id: 'assistant', label: 'Assistant', color: '#2f8a7a', description: 'Répond aux questions courtes et résume des textes.', access: 'extended', disclosure: DISCLOSURE },
    { id: 'archives', label: 'Archiviste', description: 'Range et retrouve des documents.', access: 'extended', disclosure: DISCLOSURE },
    {
      id: 'chat',
      label: 'Agent',
      description: 'Profil limité pour écrire dans les discussions.',
      offer: ['chat'],
      access: 'limited',
      accessNote: { en: 'web search only, no memory', fr: 'recherche web seulement, sans mémoire' },
      disclosure: DISCLOSURE,
    },
  ],
};

const WEB = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Its env for the app (applied before the app is imported): the manifest, written beside the instance's files. */
export async function start({ dir }) {
  if (!builtPackages(WEB).includes('hermes')) return { env: {} };
  const file = join(dir, 'agents.json');
  writeFileSync(file, `${JSON.stringify(HERMES, null, 2)}\n`);
  return { env: { KLATCHLY_AGENTS_FILE: file } };
}

let llmRuntime;
/** After the app is compiled: its runtime on llm, to clear between scripts. */
export async function patchApp(built) {
  llmRuntime = await built('ext/agents/server/llmruntime.js');
}

/** Before each script: no agent made in Settings → Agents (llm) by an earlier one. */
export async function reset() {
  llmRuntime?.clearSettingsAgents();
}
