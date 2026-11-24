import type { CategoryId } from '../../emoji';

// Search words of the reaction picker's emoji (emoji.ts), English. Every file of this folder is a language (its file
// name the code); the picker searches the words of all of them, whatever the interface language. One line per
// emoji: the emoji, a space, its words; emoji without a line are found by their category's words. Words are
// matched by prefix, ignoring case and accents.

export interface EmojiWords {
  names: string;
  categories: Record<CategoryId, string>;
}

export default {
  names: `
😀 grin smile happy
😃 smile happy joy
😄 smile laugh happy
😁 grin teeth
😆 laugh squint
😅 sweat laugh relief
🤣 rofl rolling laugh
😂 joy laugh tears lol
🙂 slight smile
🙃 upside down
😉 wink
😊 blush smile happy
😇 angel innocent halo
🥰 love hearts adore
😍 heart eyes love
🤩 star struck wow
😘 kiss blow
😗 kiss
😚 kiss closed eyes
😙 kiss smile
🥲 smile tear
😋 yum tasty
😛 tongue
😜 wink tongue crazy
🤪 zany crazy
😝 tongue squint
🤑 money
🤗 hug
🤭 oops giggle
🤫 shush quiet secret
🤔 thinking hmm
🤐 zipper mouth secret
🤨 raised eyebrow skeptical
😐 neutral
😑 expressionless
😶 no mouth speechless
😏 smirk
😒 unamused meh
🙄 eye roll
😬 grimace awkward
😌 relieved calm
😔 pensive sad
😪 sleepy
🤤 drool
😴 sleep zzz
😷 mask sick
🤒 sick fever
🤕 hurt bandage
🤢 nauseous sick
🤮 vomit sick
🤧 sneeze
🥵 hot
🥶 cold freezing
🥴 woozy drunk
😵 dizzy
🤯 mind blown
🤠 cowboy
🥳 party celebrate
🥸 disguise
😎 cool sunglasses
🤓 nerd
🧐 monocle curious
😕 confused
😟 worried
🙁 frown sad
😮 wow surprised open mouth
😯 hushed surprised
😲 astonished shocked
😳 flushed embarrassed
🥺 pleading puppy eyes
🥹 holding back tears touched
😦 frowning
😧 anguished
😨 fearful scared
😰 anxious sweat
😥 sad relieved
😢 cry sad tear
😭 sob crying
😱 scream fear
😖 confounded
😣 persevere
😞 disappointed
😓 sweat downcast
😩 weary tired
😫 tired
🥱 yawn bored
😤 triumph huff
😡 angry rage
😠 angry mad
🤬 cursing swearing
😈 devil smiling
👿 devil angry imp
💀 skull dead
💩 poop
🤡 clown
👻 ghost
👽 alien
🤖 robot
😺 cat smile
😹 cat joy
😻 cat heart eyes
😿 cat crying
🙀 cat weary
👍 thumbs up like yes ok
👎 thumbs down dislike no
👌 ok perfect
🤌 pinched fingers italian
🤏 pinch small
✌️ victory peace
🤞 fingers crossed luck
🫰 heart fingers money
🤟 love you
🤘 rock horns
🤙 call me shaka
👈 left point
👉 right point
👆 up point
👇 down point
☝️ index up
👋 wave hello bye
✋ hand stop high five
🖖 vulcan
👏 clap applause bravo
🙌 raise hands hooray
🫶 heart hands love
👐 open hands
🤲 palms up
🤝 handshake deal
🙏 pray please thanks
✍️ writing
💪 strong muscle flex
👀 eyes look
👂 ear listen
👃 nose smell
👄 mouth lips
👊 fist bump punch
🧠 brain smart
🙈 see no evil monkey
🙉 hear no evil
🙊 speak no evil
🤷 shrug dunno
🤦 facepalm
🙋 raising hand
🙇 bow sorry
❤️ heart love red
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
🤎 brown heart
💔 broken heart
❤️‍🔥 heart on fire
❤️‍🩹 mending heart
💕 two hearts love
💞 revolving hearts
💓 beating heart
💗 growing heart
💖 sparkling heart
💘 cupid arrow heart
💝 heart gift
💋 kiss lips
💯 hundred perfect
💥 boom collision
💫 dizzy star
💦 sweat drops water
💨 dash fast
💬 speech bubble
💤 zzz sleep
🐶 dog puppy
🐱 cat kitten
🐭 mouse
🐰 rabbit bunny
🦊 fox
🐻 bear
🐼 panda
🐨 koala
🐯 tiger
🦁 lion
🐮 cow
🐷 pig
🐸 frog
🐵 monkey
🐔 chicken
🐧 penguin
🐦 bird
🦄 unicorn
🐝 bee
🦋 butterfly
🐢 turtle
🐍 snake
🐙 octopus
🐬 dolphin
🐳 whale
🌵 cactus
🌲 tree pine
🌴 palm tree
🌱 seedling plant
🪴 potted plant
🍀 clover luck
🌷 tulip
🌹 rose
🌸 cherry blossom flower
🌻 sunflower
🌞 sun face
🌙 moon night
⭐ star
🌟 glowing star
✨ sparkles
⚡ lightning
🔥 fire hot lit
🌈 rainbow
☀️ sun sunny
☁️ cloud
❄️ snow cold
🌊 wave sea
🌍 earth world globe
⛰️ mountain
🍎 apple
🍌 banana
🍓 strawberry
🍑 peach
🥑 avocado
🥦 broccoli
🍞 bread
🥐 croissant
🧀 cheese
🍔 burger
🍟 fries
🍕 pizza
🍖 meat
🍣 sushi
🍜 noodles ramen
🍦 ice cream
🎂 cake birthday
🍰 cake
🍫 chocolate
🍿 popcorn
☕ coffee
🍵 tea
🥤 drink soda
🍺 beer
🍻 cheers beers
🥂 cheers champagne
🍷 wine
🍾 champagne bottle
⚽ soccer football
🏀 basketball
🎾 tennis
🏆 trophy win
🥇 gold medal first
🎉 party tada congrats
🎊 confetti
🎈 balloon
🎁 gift present
🎅 santa christmas
🎄 christmas tree
🎤 microphone sing
🎵 music note
🎶 music notes
🎸 guitar
🎮 game
🎯 target bullseye
🚗 car
🚑 ambulance
✈️ plane travel
🚀 rocket
🏠 house home
⏰ alarm clock
🕒 clock time
⌛ hourglass
💡 idea bulb
💰 money bag
💸 money flying
💎 diamond gem
🛠️ tools
🔑 key
📱 phone
💻 laptop
📷 camera photo
📦 package box
📝 memo note
📌 pin
🔍 search
🔒 lock
✅ check done yes
✔️ check
❌ cross no wrong
❓ question
❗ exclamation
‼️ double exclamation
⚠️ warning
🚫 forbidden
🆗 ok
🆒 cool
🆕 new
🆘 sos help
🔴 red circle
🟢 green circle
🏁 finish flag
🇫🇷 france flag
🇯🇵 japan flag
0️⃣ zero
1️⃣ one
2️⃣ two
3️⃣ three
4️⃣ four
5️⃣ five
6️⃣ six
7️⃣ seven
8️⃣ eight
9️⃣ nine
🫠 melting
🫨 shaking
`,
  categories: {
    smileys: 'smileys faces emotion',
    people: 'people hands gestures body',
    hearts: 'hearts love symbols',
    nature: 'animals nature plants weather',
    food: 'food drink',
    activities: 'activities sport travel places',
    objects: 'objects',
    symbols: 'symbols flags numbers',
  },
} satisfies EmojiWords;
