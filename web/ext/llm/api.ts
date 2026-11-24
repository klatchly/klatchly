import type { ProviderModule } from '#core/sdk.js';

// The llm package's public entry: what a package that requires it (`requires: { llm: '^1.0' }`) may know of it.
// Types only; the provider itself comes from ModuleContext.provider<LlmProvider>('llm') when that package starts.
// A change here changes what other packages build on: bump llm's version (ext/contracts.test.ts says which bump).

/** A part of a user turn with a picture (OpenAI's vision format): its text, or the picture as a data: URL. Since 1.2. */
export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export type ChatMessages = { role: 'system' | 'user' | 'assistant'; content: string }[];

/** Turns whose content may mix text and pictures, for a model that reads images (completePicturesFor). Since 1.2. */
export type PictureMessages = { role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }[];

/** A primary model and an optional fallback (null or absent: none). */
export interface Route {
  model: string;
  fallback?: string | null;
}

export type Outcome = 'ok' | 'error' | 'aborted';

/** A model's last calls (in memory, the 20 latest). */
export interface ModelStats {
  calls: number;
  ok: number;
  errors: number;
  /** Calls dropped because the other model answered first (the model was slow). */
  aborted: number;
  /** Median latency of the successful calls, if any. */
  medianMs: number | null;
  lastMs: number | null;
  lastOutcome: Outcome | null;
  lastAt: number | null;
}

export interface CompleteOptions {
  /** How long the primary model gets alone before the fallback is started alongside it (default patienceMs). */
  patienceMs?: number;
  /** Hard cap for the whole call, fallback included (default capMs). */
  capMs?: number;
  /** Name in the logs (never any content). */
  feature?: string;
}

/**
 * A feature of another package that calls a model (writing's translation of received messages…): its models are
 * chosen in Settings → Default models, among the models enabled on the providers. Since 1.1.
 */
export interface LlmUse {
  /** '<package id>.<feature>' (lower case), e.g. 'writing.translate'. */
  id: string;
  /** Its name on that page, by language code (English required). */
  label: Readonly<Record<string, string>>;
  /**
   * Its models from before llm 1.1 (model ids of the server's endpoint, as its package stored them): adopted the
   * first time this use registers, then never read again. Absent or null: the defaults.
   */
  legacy?: Route | null;
}

export interface LlmProvider extends ProviderModule {
  /** The default route: KLATCHLY_LLM_MODEL, and KLATCHLY_LLM_FALLBACK unless unset or the same model. */
  defaults(): Required<Route>;
  readonly patienceMs: number;
  readonly capMs: number;
  /**
   * One chat completion with fallback: the primary starts alone, the fallback when the primary fails or after
   * `patienceMs`; the first good answer wins and the other call is aborted. Rejects with the primary's error
   * when every started call failed, or 'llm timeout' at `capMs`. The text comes back trimmed, never empty.
   */
  complete(messages: ChatMessages, route: Route, opts?: CompleteOptions): Promise<string>;
  /** Model ids the endpoint offers ("-review" variants left out), cached a few minutes; throws if never reached. */
  models(force?: boolean): Promise<string[]>;
  stats(model: string): ModelStats;
  /** Shape of a model id the endpoint may list (what a settings form may store). */
  validModelId(v: unknown): v is string;
  /**
   * Who answers, for the users' privacy line (KLATCHLY_LLM_LABEL: a name, or a JSON object of names by language
   * code), or null when unset.
   */
  label(): Readonly<Record<string, string>> | null;
  /**
   * Lists a use on Settings → Default models while the caller is on (call at start); returns its removal (call at
   * stop). Its choice of models is kept while it is gone. Since 1.1.
   */
  use(u: LlmUse): () => void;
  /**
   * `complete` on the models chosen for a use (Settings → Default models; the server's defaults until one is
   * chosen), whatever their providers. Rejects with 'disabled' when it has none. Since 1.1.
   */
  completeFor(use: string, messages: ChatMessages, opts?: CompleteOptions): Promise<string>;
  /**
   * `completeFor` with pictures in the turns (ContentPart, OpenAI's vision format), for a use whose models read
   * images (a model that does not answers an error, as the provider says). Since 1.2.
   */
  completePicturesFor(use: string, messages: PictureMessages, opts?: CompleteOptions): Promise<string>;
  /** Who answers for a use (its primary model's provider), for the users' privacy line; null when unnamed. Since 1.1. */
  labelFor(use: string): Readonly<Record<string, string>> | null;
}
