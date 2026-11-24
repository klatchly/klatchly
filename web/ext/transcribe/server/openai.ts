// The OpenAI transcription API (POST <base>/audio/transcriptions, multipart/form-data: file, model, language,
// response_format), which OpenAI, Groq and the self-hosted Whisper servers speak. The file is named after its type
// (these servers often guess the format from the name). The key goes in a header, never in the URL; redirects are
// refused (a key never follows one).

export interface OpenAiTarget {
  url: string;
  key: string | null;
  model: string;
}

/** A refused or failed call: the HTTP status (null: no answer) and a short reason, never the answer's text. */
export class OpenAiError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

const MAX_ANSWER = 1024 * 1024;

/** The answer's text, read up to MAX_ANSWER bytes as it streams (chunked or decompressed, whatever its header says). */
async function readAnswer(res: Response): Promise<string> {
  const tooLarge = () => new OpenAiError(res.status, 'answer too large');
  if (Number(res.headers.get('content-length')) > MAX_ANSWER) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (e) {
        throw new OpenAiError(res.status, e instanceof Error ? e.name : 'network');
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ANSWER) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function transcribeOpenAi(t: OpenAiTarget, audio: { data: Uint8Array; mime: string; fileName: string }, language: string, timeoutMs: number, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
  const form = new FormData();
  form.append('file', new Blob([audio.data as Uint8Array<ArrayBuffer>], { type: audio.mime }), audio.fileName);
  form.append('model', t.model);
  if (language) form.append('language', language);
  form.append('response_format', 'json');
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${t.url}/audio/transcriptions`, {
      method: 'POST',
      // identity: an answer is never compressed (a few KB of gzip could inflate past MAX_ANSWER before any check).
      headers: { 'accept-encoding': 'identity', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
      body: form,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    throw new OpenAiError(null, timeout.aborted ? 'timeout' : signal?.aborted ? 'aborted' : e instanceof Error ? e.name : 'network');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new OpenAiError(res.status, `http ${res.status}`);
  }
  const body = await readAnswer(res);
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    throw new OpenAiError(res.status, 'not json');
  }
  const o = j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
  if (typeof o.text !== 'string') throw new OpenAiError(res.status, 'no text');
  const lang = typeof o.language === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(o.language) ? o.language : undefined;
  return { text: o.text.trim(), ...(lang ? { language: lang } : {}) };
}
