import type { EmojiWords } from './locales/emoji/en';
import { normEmoji } from './reactions';

// Small built-in emoji set for the reaction picker (no third-party picker, no network fetch), with search words
// for the common ones in every language of locales/emoji/. Networks that restrict reactions publish their own list
// (capabilities.allowedReactions): the picker then only offers those.

export type CategoryId = 'smileys' | 'people' | 'hearts' | 'nature' | 'food' | 'activities' | 'objects' | 'symbols';
const CATEGORY_IDS: CategoryId[] = ['smileys', 'people', 'hearts', 'nature', 'food', 'activities', 'objects', 'symbols'];

const sets: [string, string][] = [
  ['😀', '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 🥹 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾'],
  ['👍', '👍 👎 👌 🤌 🤏 ✌️ 🤞 🫰 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👋 🤚 🖐️ ✋ 🖖 👏 🙌 🫶 👐 🤲 🤝 🙏 ✍️ 💅 💪 🦾 👀 👁️ 👅 👄 🫦 🧠 🫀 🙈 🙉 🙊 🤷 🤷‍♂️ 🤷‍♀️ 🙋 🙇 🤦 💁 🙆 🙅 🧑‍💻 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🎅 🤶'],
  ['❤️', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💌 💋 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤'],
  ['🐶', '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐢 🐍 🐙 🦀 🐠 🐬 🐳 🦈 🐊 🐘 🦒 🐕 🐈 🌵 🎄 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌷 🌹 🌺 🌸 🌼 🌻 🌞 🌝 🌚 🌙 ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ ☃️ 🌊'],
  ['🍕', '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥦 🥕 🌽 🌶️ 🥐 🍞 🥖 🧀 🥚 🍳 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🥛 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾'],
  ['⚽', '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥊 🥋 ⛳ 🎣 🎿 🏂 🏋️ 🚴 🏊 🏄 🧘 🏆 🥇 🥈 🥉 🏅 🎖️ 🎫 🎟️ 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 🎯 🎳 🎮 🧩 🎉 🎊 🎈 🎁 🎀 🪅 🚗 🚕 🚌 🚓 🚑 🚒 🚲 🛵 🏍️ ✈️ 🚀 🛸 🚁 ⛵ 🚢 🏠 🏡 🏢 🏰 🗼 🗽 ⛩️ 🗻 🏝️ 🏖️'],
  ['💡', '⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 📷 📹 🎥 📞 ☎️ 📺 📻 ⏰ ⌛ ⏳ 🔋 🔌 💡 🔦 🕯️ 💸 💵 💶 💰 💳 💎 ⚖️ 🔧 🔨 🛠️ ⚙️ 🔫 💣 🔪 🛡️ 🔮 💊 💉 🩹 🧬 🔬 🔭 🧹 🧺 🧻 🚽 🛁 🔑 🗝️ 🚪 🛏️ 🛋️ 🎁 ✉️ 📦 📝 📎 📌 📍 ✂️ 🖊️ ✏️ 🔍 🔒 🔓'],
  ['✅', '✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ❓ ❔ ❕ ❗ ‼️ ⁉️ 💲 ♻️ ⚠️ 🚫 ⛔ 📛 🔞 💤 🆗 🆒 🆕 🆓 🆙 🆘 🔝 🔜 ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ 🔀 🔁 🔂 🔄 ℹ️ 🔤 #️⃣ *️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣ 8️⃣ 9️⃣ 🔟 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟩 🟦 ⬛ ⬜ 🔶 🔷 🏳️ 🏴 🏁 🚩 🏳️‍🌈 🇫🇷 🇯🇵 🇪🇺 🇬🇧 🇺🇸'],
];


export const CATEGORIES: { icon: string; id: CategoryId; emoji: string[] }[] = sets.map(([icon, list], i) => ({ icon, id: CATEGORY_IDS[i]!, emoji: list.split(' ') }));

// Search words, one file per language (locales/emoji/<code>.ts): all of them are searched.
const WORDS = Object.values(import.meta.glob<{ default: EmojiWords }>('./locales/emoji/*.ts', { eager: true })).map((m) => m.default);

// Accent- and case-insensitive words ("coeur" finds "cœur", "e" finds "é").
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/œ/g, 'oe').toLowerCase();

let index: Map<string, string> | undefined;
function words(e: string): string {
  if (!index) {
    index = new Map();
    const add = (key: string, w: string) => index!.set(key, `${index!.get(key) ?? ''} ${fold(w)}`.trim());
    for (const lang of WORDS)
      for (const line of lang.names.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp > 0) add(normEmoji(line.slice(0, sp)), line.slice(sp + 1));
      }
    for (const c of CATEGORIES) {
      const w = WORDS.map((lang) => lang.categories[c.id]).join(' ');
      for (const em of c.emoji) add(normEmoji(em), w);
    }
  }
  return index.get(normEmoji(e)) ?? '';
}

/** Emoji of `pool` whose words in any language (or its category's) start with every word of the query. */
export function searchEmoji(query: string, pool: string[]): string[] {
  const q = fold(query).split(/\s+/).filter(Boolean);
  if (!q.length) return pool;
  return pool.filter((e) => {
    const w = ` ${words(e)}`;
    return q.every((t) => w.includes(` ${t}`));
  });
}

/** Every emoji of the built-in set, in category order (search when the network has no list). */
export const ALL_EMOJI: string[] = CATEGORIES.flatMap((c) => c.emoji);
