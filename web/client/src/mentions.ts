// @mentions: the composer shows "@Name"; the API gets Matrix pills as Markdown links, a convention of the canonical
// model (the Desktop API's: Outgoing.text) that every connector converts (beeper-server renders them as
// <a href="https://matrix.to/#/@user:server"> and bridges turn them into native mentions). Offered only where the
// chat's own capabilities allow it (caps.ts canMention).

export type Mention = { name: string; id: string };

export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const escapeMd = (s: string) => s.replace(/([\\[\]()*_~`])/g, '\\$1');

/** Display text -> text sent to the API: picked mentions become Matrix pills (Markdown links). */
export function withMentions(text: string, mentions: Mention[]): string {
  const used = mentions.filter((m) => text.includes(`@${m.name}`)).sort((a, b) => b.name.length - a.name.length);
  if (!used.length) return text;
  const marks = used.map((_, i) => `\u0000${i}\u0000`);
  let out = text.replace(/\u0000/g, '');
  used.forEach((m, i) => (out = out.split(`@${m.name}`).join(marks[i]!)));
  used.forEach((m, i) => (out = out.split(marks[i]!).join(`[${escapeMd(m.name)}](https://matrix.to/#/${encodeURI(m.id)})`)));
  return out;
}

