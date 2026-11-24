// What the offline instance's fakes share with the scripts, through the test hooks on the fake Desktop API's port
// (beeper.mjs: POST /__reset, GET /__calls, POST /__<hook>):
// - calls: what the fakes were asked that tells a network something about the user's reading, for the scripts to
//   check (GET /__calls): the Desktop API's reads (each sends a read receipt) in `beeperReads`; a package's fake adds
//   its own list with track() (e.g. a gateway's "seen" events). Emptied by every reset (before each
//   script);
// - hooks: what a package's fake lets the scripts do to it (POST /__<name>, the body as text), registered with
//   hook() when it starts (ext/<id>/test/offline.mjs), e.g. an incoming message on its network.
export const calls = { beeperReads: [] };

/** A list of calls of a package's fake, under `name` in GET /__calls; emptied at each reset. */
export function track(name) {
  calls[name] ??= [];
  return calls[name];
}

export function resetCalls() {
  for (const list of Object.values(calls)) list.length = 0;
}

const hooks = new Map();

/** POST /__<name> on the fake Desktop API's port calls `fn(body)` (the body as text). */
export function hook(name, fn) {
  if (!/^[a-z0-9][a-z0-9/_-]*$/.test(name)) throw new Error(`hook name ${name}`);
  if (hooks.has(name)) throw new Error(`hook ${name} twice`);
  hooks.set(name, fn);
}

/** The hook registered under `name`, if any. */
export const hookFor = (name) => hooks.get(name);
