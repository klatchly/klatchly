// Frames for the signed-in browsers, from the packages (ModuleContext.toBrowsers): sent over every open /api/ws
// socket (ws.ts), next to the upstream events. Content-free pings by convention ("something changed in this
// conversation"): a browser refetches what it shows. The registry checks the type before a frame gets here.

export type BrowserFrame = { type: string } & Record<string, unknown>;

const listeners = new Set<(ev: BrowserFrame) => void>();

export function onBrowserFrame(l: (ev: BrowserFrame) => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export const broadcast = (ev: BrowserFrame): void => listeners.forEach((l) => l(ev));
