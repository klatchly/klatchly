// The fake OpenAI-compatible model (KLATCHLY_LLM_URL, ext/llm/server/llm.ts) for the offline instance
// (test/e2e/offline/server.mjs, which starts the fake of every listed package that has a test/offline.mjs), on a free loopback port: GET /v1/models and POST /v1/chat/completions, behind the offline bearer key. No model at all:
// each answer is derived from the prompt, at once and always the same, so the scripts can assert on it:
// - the Test button's health check answers "ok";
// - a translation (writing's translate.ts, or the composer's "Translate the draft into …") is the text after the
//   target language's own name: "Tiếng Việt: …", "English: …" (emoji, links and mentions untouched);
// - a fix (spelling, grammar, phrasing) applies a small table of French and English corrections to the draft and
//   capitalises its sentences: "je pense que on pourrais" -> "Je pense qu'on pourrait.".
// - a picture's translation is "<caption> · picture text (<type>, <bytes> bytes)" in that form, and a GIF has no text.
// - a question about a conversation (ask) answers with the number of messages it got, the period and the question.
// Anything else is echoed back. The model ids are made up; "-review" ones must not be offered by the app.
// A second provider on the same port, under /second/api/v1 (Settings → Providers adds it in the scripts), made like
// OpenRouter: its model list public (with names, and a model that only draws), GET /key checks its own key
// (SECOND_KEY, never the first one's), its completions as above. /redirect/v1 answers 302 to the first one: the app
// must not follow it.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const MODELS = ['fake/swift-1', 'fake/steady-2', 'fake/careful-3', 'fake/swift-1-review'];
const [PRIMARY, FALLBACK] = MODELS;
export const SECOND = ['second/alpha-1', 'second/beta-2'];
export const SECOND_KEY = 'offline-second-key-0123';

// The languages' own names, by the English name the prompts use (ext/writing/langs.ts LANG_NAMES).
const NATIVE = { Vietnamese: 'Tiếng Việt', French: 'Français', English: 'English', Japanese: '日本語', Chinese: '中文', Korean: '한국어', Thai: 'ไทย', Spanish: 'Español', German: 'Deutsch', Italian: 'Italiano', Portuguese: 'Português', Russian: 'Русский' };

// What each fix level corrects, on top of the level below (word-boundary, case kept on the first letter).
const SPELLING = [['recieve', 'receive'], ['teh', 'the'], ['tommorow', 'tomorrow'], ['demian', 'demain']];
const GRAMMAR = [['que on', "qu'on"], ['on pourrais', 'on pourrait'], ['je pourrait', 'je pourrais'], ['i is', 'I am'], ['he go', 'he goes']];
const REPHRASE = [['je pense', 'je crois'], ['se voir', 'se retrouver'], ['i think', 'I believe']];

// Links, emoji and @mentions are never touched (the app refuses an answer that lost one).
const KEEP = /(https?:\/\/[^\s<>()"']+|@[\w.-]+|\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}\p{Emoji_Modifier}]*)/gu;

const replaceAll = (s, table) => table.reduce((out, [from, to]) => out.replace(new RegExp(`\\b${from}\\b`, 'giu'), (m) => (m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to)), s);

/** A fix of the draft at one level: the tables, then capitals at sentence starts and a final full stop. */
export function fix(draft, level) {
  const tables = { spelling: [SPELLING], grammar: [SPELLING, GRAMMAR], rephrase: [SPELLING, GRAMMAR, REPHRASE] }[level];
  // The kept tokens step aside while the words are fixed.
  const kept = [];
  let s = draft.replace(KEEP, (m) => (kept.push(m), `\u0000${kept.length - 1}\u0000`));
  for (const t of tables) s = replaceAll(s, t);
  s = s.replace(/(^|[.!?]\s+|\n)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
  if (/\p{L}$/u.test(s)) s += '.';
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

const between = (s, tag) => s.match(new RegExp(`<${tag}>\\n?([\\s\\S]*?)\\n?</${tag}>`))?.[1] ?? '';
const translation = (text, lang) => `${NATIVE[lang] ?? lang}: ${text}`;

/** The answer to one chat completion, from its messages (the prompts of ext/writing/server/*.ts). */
export function answer(messages) {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const user = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
  if (/health check/i.test(system)) return 'ok';
  // A picture (writing's imagePrompt): "the text it shows" is its type and size, a GIF has none; its caption first.
  if (Array.isArray(user)) {
    const lang = system.match(/translate it into (\w+)/)?.[1];
    const url = user.find((p) => p.type === 'image_url')?.image_url?.url ?? '';
    const pic = url.match(/^data:(image\/[a-z]+);base64,(.*)$/);
    if (!lang || !pic) return 'echo: picture';
    if (pic[1] === 'image/gif') return '[NO_TEXT]';
    const caption = between(user.find((p) => p.type === 'text')?.text ?? '', 'caption');
    return translation(`${caption ? `${caption} · ` : ''}picture text (${pic[1]}, ${Buffer.from(pic[2], 'base64').length} bytes)`, lang);
  }
  let m = system.match(/translation engine\. Translate the chat message inside <message> tags into (\w+)/);
  if (m) return translation(between(user, 'message'), m[1]);
  m = system.match(/Translate the draft into (\w+)/);
  if (m) return translation(between(user, 'draft'), m[1]);
  const level = /Fix only spelling/.test(system) ? 'spelling' : /Fix spelling and grammar/.test(system) ? 'grammar' : /Improve the phrasing/.test(system) ? 'rephrase' : null;
  if (level) return fix(between(user, 'draft'), level);
  // A question about a conversation (ask's prompt): how many messages it got, the period, the question.
  if (/questions about one of their chat conversations/.test(system)) {
    const first = messages.find((x) => x.role === 'user')?.content ?? '';
    const lines = between(first, 'messages').split('\n').filter(Boolean).length;
    const period = first.match(/^Period: (.*)$/m)?.[1] ?? '?';
    return `${lines} messages read (${period}).\n• Question: ${user.replace(/^[\s\S]*Question: /, '')}`;
  }
  return `echo: ${user}`;
}

/** Starts the fake; its env for the app (applied before the app is imported). */
export async function start({ dir }) {
  const key = readFileSync(join(dir, 'key'), 'utf8').trim();
  const server = createServer((req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://llm');
    let path = url.pathname;
    if (path.startsWith('/redirect/')) return req.resume(), res.writeHead(302, { location: '/v1/models' }), res.end();
    const second = path.startsWith('/second/api/v1/');
    if (second) {
      path = path.slice('/second/api'.length);
      if (req.method === 'GET' && path === '/v1/models')
        return json(200, { data: [...SECOND.map((id, i) => ({ id, name: `Second ${['Alpha', 'Beta'][i]}`, architecture: { output_modalities: ['text'] } })), { id: 'second/paint', name: 'Second Paint', architecture: { output_modalities: ['image'] } }] });
    }
    if (req.headers.authorization !== `Bearer ${second ? SECOND_KEY : key}`) return req.resume(), json(401, { error: { message: 'bad key', type: 'invalid_request_error' } });
    if (second && req.method === 'GET' && path === '/v1/key') return json(200, { data: { label: 'offline', limit: null, usage: 0 } });
    if (!second && req.method === 'GET' && path === '/v1/models') return json(200, { object: 'list', data: MODELS.map((id) => ({ id, object: 'model', owned_by: 'offline' })) });
    if (req.method !== 'POST' || path !== '/v1/chat/completions') return req.resume(), json(404, { error: { message: 'not found' } });
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: { message: 'bad json' } });
      }
      if (!(second ? SECOND : MODELS).includes(body.model)) return json(404, { error: { message: `unknown model ${body.model}`, code: 'model_not_found' } });
      if (!Array.isArray(body.messages)) return json(400, { error: { message: 'messages required' } });
      const content = answer(body.messages);
      const id = `chatcmpl-offline-${Date.now()}`;
      if (!body.stream) return json(200, { id, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
      // Streamed (the app does not ask for it): the whole answer in one chunk.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { env: { KLATCHLY_LLM_KEY_FILE: join(dir, 'key'), KLATCHLY_LLM_URL: `http://127.0.0.1:${server.address().port}/v1`, KLATCHLY_LLM_MODEL: PRIMARY, KLATCHLY_LLM_FALLBACK: FALLBACK, KLATCHLY_LLM_LABEL: '{"en":"offline model","fr":"modèle hors ligne"}' } };
}
