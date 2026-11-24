// The shapes of the package's API, shared by its server half (server/routes.ts answers them) and its client half
// (client/api.ts reads them). Types only, no import: both builds compile this file (the server's for Node, the
// client's for the browser), so it must not pull in code of either side.

/** What the Settings page stores. Keep stored shapes small: unknown fields are dropped. */
export interface ExamplePrefs {
  /** "Count words" also counts characters. */
  characters: boolean;
}

/** GET /api/example/hello */
export interface HelloReply {
  /** KLATCHLY_EXAMPLE_GREETING, or null: the client then shows its own default, in the user's language. */
  greeting: string | null;
  /** When the package last started (ISO), null while it is off. */
  startedAt: string | null;
  /** Calls to this route since then. */
  calls: number;
}
