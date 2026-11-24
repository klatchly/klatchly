import type { Context, MiddlewareHandler } from 'hono';
import { stepUpLeft, stepUpMethods, type StepUpMethod } from './auth.js';
import { store, type Env } from './context.js';

// A recent confirmation (step-up) before a sensitive change: passkeys and connected devices (signin.ts), turning an
// extension on or off (app.ts), and any package's own (an LLM provider's key…). A session may change them for
// STEP_UP_MS (auth.ts) after a full sign-in or a passkey step-up (POST /api/auth/stepup/passkey); GET /api/auth/stepup says how long is left and how
// to confirm. The client side is client/src/StepUp.tsx.

export interface StepUpState {
  /** Time left to change sensitive settings (0: confirm first). */
  leftMs: number;
  /** How this owner can confirm (none: no passkey left, add one with the CLI's enrollment code). */
  methods: StepUpMethod[];
}

export function stepUpState(c: Context<Env>): StepUpState {
  const st = store.read();
  return { leftMs: stepUpLeft(st, c.get('session')!), methods: stepUpMethods(st) };
}

/** Behind the session check: answers 403 { error: 'step_up' } unless this session confirmed recently. */
export const requireStepUp: MiddlewareHandler<Env> = async (c, next) => {
  if (stepUpState(c).leftMs <= 0) return c.json({ error: 'step_up' }, 403);
  await next();
};
