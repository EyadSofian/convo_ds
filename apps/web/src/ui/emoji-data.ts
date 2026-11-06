/**
 * The emoji the composer offers, grouped the way people look for them.
 *
 * A curated set rather than the whole Unicode table: these are the ones a
 * support or sales team actually sends, and a short list a person can scan beats
 * three thousand they have to search. Each entry carries a few words in both
 * languages, so the search box finds "شكرا" as readily as "thanks".
 */

/** The `openMenu` value of the composer's emoji picker. */
export const EMOJI_MENU = 'composer-emoji';

export interface EmojiEntry {
  readonly char: string;
  /** Space-separated search words, Arabic and English, lower case. */
  readonly words: string;
}

export interface EmojiCategory {
  readonly id: string;
  /** The emoji that stands for the category on its tab. */
  readonly mark: string;
  readonly ar: string;
  readonly en: string;
  readonly emojis: readonly EmojiEntry[];
}

function entries(list: string): readonly EmojiEntry[] {
  return list
    .trim()
    .split('\n')
    .map((line) => {
      const [char = '', ...words] = line.trim().split(/\s+/u);
      return { char, words: words.join(' ').toLocaleLowerCase() };
    });
}

export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  {
    id: 'smileys',
    mark: '😀',
    ar: 'وجوه',
    en: 'Smileys',
    emojis: entries(`
      😀 smile grin happy ابتسامة ضحكة سعيد
      😃 smile happy joy ابتسامة فرحان
      😄 laugh smile happy ضحك فرح
      😁 grin beam teeth ضحكة سنان
      😆 laugh haha ضحك هههه
      😅 sweat laugh relief ضحك عرق
      😂 joy tears laugh lol ضحك دموع
      🤣 rofl laugh ضحك موت
      😊 blush smile happy ابتسامة خجل لطيف
      😇 angel halo innocent ملاك بريء
      🙂 slight smile ابتسامة خفيفة
      🙃 upside silly مقلوب
      😉 wink غمزة
      😌 relieved calm مرتاح هادي
      😍 love heart eyes حب معجب
      🥰 love hearts affection حب قلوب
      😘 kiss love بوسة حب
      😋 yum tasty لذيذ
      😜 wink tongue playful هزار لسان
      🤗 hug welcome حضن ترحيب
      🤭 oops giggle ضحكة مكتومة
      🤫 shush quiet secret سكوت سر
      🤔 think hmm تفكير
      🤐 zip silent ساكت
      🤨 doubt raised eyebrow شك
      😐 neutral meh محايد
      😶 speechless blank بدون كلام
      😏 smirk ابتسامة جانبية
      🙄 eyeroll ملل
      😬 grimace awkward محرج
      😮‍💨 exhale sigh تنهيدة
      😔 sad pensive حزين
      😪 sleepy نعسان
      😴 sleep tired نوم تعبان
      😷 mask sick كمامة مريض
      🤒 ill fever سخونة مرض
      🥴 dizzy woozy دايخ
      🤯 mind blown مصدوم
      🥳 party celebrate حفلة احتفال
      😎 cool sunglasses روش نظارة
      🤓 nerd geek study مذاكرة شاطر
      🧐 monocle inspect تدقيق
      😕 confused محتار
      😟 worried قلقان
      🙁 frown sad زعلان
      😮 wow surprised مندهش
      😲 shocked astonished صدمة
      😳 flushed embarrassed خجلان
      🥺 pleading please ارجوك رجاء
      😢 cry sad tear بكاء دمعة
      😭 sob crying بكاء شديد
      😱 scream fear رعب
      😖 confounded مستاء
      😞 disappointed خيبة
      😓 sweat downcast ضغط
      😩 weary tired تعبان
      🥱 yawn bored تثاؤب
      😤 triumph huff غضبان
      😠 angry غضب
      😡 rage mad غضب شديد
    `),
  },
  {
    id: 'gestures',
    mark: '👋',
    ar: 'إيماءات',
    en: 'Gestures',
    emojis: entries(`
      👋 wave hello hi bye أهلا سلام باي
      🤚 raised back hand يد
      ✋ hand stop raise قف يد
      👌 ok perfect تمام ممتاز
      🤌 pinched italian استنى
      🤏 pinch small شوية
      ✌️ victory peace سلام نصر
      🤞 fingers crossed luck بالتوفيق حظ
      🤟 love you بحبك
      🤘 rock
      🤙 call me اتصل
      👈 left point شمال
      👉 right point يمين
      👆 up point فوق
      👇 down point تحت
      ☝️ index one واحد
      👍 thumbs up yes ok like موافق تمام لايك
      👎 thumbs down no dislike مش موافق
      ✊ fist قبضة
      👊 punch fist bump
      👏 clap applause bravo تصفيق برافو
      🙌 raise hands hooray هييه
      👐 open hands يدين
      🤲 palms dua دعاء
      🤝 handshake deal agreement اتفاق مصافحة
      🙏 pray thanks please شكرا من فضلك دعاء
      ✍️ writing كتابة
      💪 strong muscle قوة
      🫶 heart hands love حب
      👀 eyes look شوف عيون
      🧠 brain smart ذكي عقل
      💁 info help معلومة
      🙋 raise hand question سؤال
      🤷 shrug dunno مش عارف
      🤦 facepalm يا ساتر
      🙇 bow sorry اسف
    `),
  },
  {
    id: 'hearts',
    mark: '❤️',
    ar: 'قلوب',
    en: 'Hearts',
    emojis: entries(`
      ❤️ heart love red حب قلب
      🧡 orange heart قلب برتقالي
      💛 yellow heart قلب اصفر
      💚 green heart قلب اخضر
      💙 blue heart قلب ازرق
      💜 purple heart قلب بنفسجي
      🖤 black heart قلب اسود
      🤍 white heart قلب ابيض
      🤎 brown heart قلب بني
      💔 broken heart قلب مكسور
      ❣️ heart exclamation
      💕 two hearts قلبين
      💞 revolving hearts
      💓 beating heart
      💗 growing heart
      💖 sparkling heart
      💘 cupid arrow
      💝 gift heart هدية
      ❤️‍🔥 heart fire شغف
      💌 love letter رسالة حب
    `),
  },
  {
    id: 'celebration',
    mark: '🎉',
    ar: 'احتفال',
    en: 'Celebrate',
    emojis: entries(`
      🎉 party tada congrats مبروك احتفال
      🎊 confetti مبروك
      🎈 balloon بالون
      🎁 gift present هدية
      🎂 birthday cake عيد ميلاد
      🏆 trophy win كأس فوز
      🥇 first medal gold المركز الاول
      🏅 medal ميدالية
      🌟 star glow نجمة
      ⭐ star نجمة
      ✨ sparkles magic لمعة
      🔥 fire hot lit نار
      💯 hundred perfect مية مية
      👑 crown ملك
      💎 diamond الماس
      🌸 blossom flower وردة
      🌹 rose وردة حمرا
      🌷 tulip توليب
      🌻 sunflower عباد الشمس
      🌙 moon night ramadan قمر رمضان
      ☀️ sun morning شمس صباح
      🌈 rainbow قوس قزح
      ☕ coffee قهوة
      🍰 cake كيكة
      🍕 pizza بيتزا
      🌍 world globe العالم
      ✈️ plane travel سفر
      🎵 music موسيقى
    `),
  },
  {
    id: 'work',
    mark: '📚',
    ar: 'دراسة وعمل',
    en: 'Study & work',
    emojis: entries(`
      📚 books study course كتب دراسة كورس
      📖 book read كتاب قراءة
      🎓 graduate degree تخرج شهادة
      🏫 school مدرسة
      ✏️ pencil قلم
      📝 memo note form ملاحظة استمارة
      📅 calendar date موعد تاريخ
      🗓️ schedule جدول
      ⏰ alarm clock time منبه وقت
      ⏳ hourglass wait انتظار
      🕒 clock time ساعة
      📞 phone call اتصال تليفون
      📱 mobile موبايل
      💻 laptop online اونلاين لابتوب
      🖥️ computer كمبيوتر
      📧 email ايميل
      📩 message inbox رسالة
      💬 chat speech محادثة كلام
      🗣️ speaking talk كلام محادثة
      📎 attach paperclip مرفق
      📌 pin تثبيت
      📍 location place مكان عنوان
      🔗 link رابط
      💡 idea tip فكرة
      🔔 bell notify تنبيه
      🎯 target goal هدف
      🚀 rocket launch انطلاق
      📈 growth chart up نمو
      💳 card payment كارت دفع
      💰 money مال فلوس
      🧾 receipt invoice فاتورة ايصال
      🏷️ tag price discount خصم سعر
    `),
  },
  {
    id: 'symbols',
    mark: '✅',
    ar: 'رموز',
    en: 'Symbols',
    emojis: entries(`
      ✅ check done yes تم صح
      ✔️ check mark صح
      ☑️ ballot check
      ❌ cross no wrong غلط لا
      ❎ cross mark
      ⚠️ warning تحذير
      ❗ exclamation important مهم
      ❓ question سؤال
      ‼️ double exclamation
      ⁉️ interrobang
      ➡️ right arrow سهم
      ⬅️ left arrow سهم
      ⬆️ up arrow سهم
      ⬇️ down arrow سهم
      🔄 refresh repeat تكرار
      🆕 new جديد
      🆗 ok تمام
      🆓 free مجاني
      🔴 red circle احمر
      🟠 orange circle برتقالي
      🟡 yellow circle اصفر
      🟢 green circle اخضر
      🔵 blue circle ازرق
      ⚫ black circle اسود
      ⏸️ pause ايقاف
      ▶️ play تشغيل
      🔒 lock private قفل
      🔓 unlock مفتوح
      ♻️ recycle
      ℹ️ info معلومات
    `),
  },
];

/** Every emoji in the set, for search and for checking a stored recent list. */
export const ALL_EMOJI: readonly EmojiEntry[] = EMOJI_CATEGORIES.flatMap((category) => category.emojis);

/** How many recently used emoji are remembered and shown. */
export const RECENT_EMOJI_LIMIT = 16;

/**
 * Normalises Arabic for matching: the alef and yeh forms people type
 * interchangeably, taa marbuta, and diacritics. "اهلا" finds "أهلا".
 */
export function foldArabic(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[ً-ْـ]/gu, '')
    .replace(/[أإآ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .replace(/ة/gu, 'ه');
}

const FOLDED: readonly (readonly [EmojiEntry, string])[] = ALL_EMOJI.map((entry) => [entry, foldArabic(entry.words)]);

/** Emoji whose words contain every term of the query, in set order. */
export function searchEmoji(query: string): readonly EmojiEntry[] {
  const terms = foldArabic(query).split(/\s+/u).filter((term) => term !== '');
  if (terms.length === 0) return [];
  return FOLDED.filter(([entry, words]) => terms.every((term) => words.includes(term) || entry.char === term)).map(([entry]) => entry);
}

/** Moves one emoji to the front of the recent list, keeping it short and unique. */
export function rememberEmoji(recent: readonly string[], emoji: string): readonly string[] {
  return [emoji, ...recent.filter((entry) => entry !== emoji)].slice(0, RECENT_EMOJI_LIMIT);
}
