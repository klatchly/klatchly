// The llm package configured against nothing real, for the whole-build tests (ext/build.test.ts reads the
// test/build-env.ts of every listed package before the build is imported): a dead endpoint, a made-up key.
export default async function buildEnv({ key }: { dir: string; key: string }): Promise<Record<string, string>> {
  return { KLATCHLY_LLM_URL: 'http://127.0.0.1:9/v1', KLATCHLY_LLM_MODEL: 'test-model', KLATCHLY_LLM_KEY_FILE: key };
}
