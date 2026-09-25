/**
 * Locale-aware formatting. Arabic is the default product language; English is a
 * first-class alternative, not a fallback. Anything that mixes scripts (phones,
 * emails, handles, order and message IDs) is rendered inside `<bdi>` by the
 * callers — see docs/design/design-reference.md §5.
 */

export type Lang = 'ar' | 'en';

export const LOCALE: Record<Lang, string> = { ar: 'ar-EG', en: 'en-GB' };

/**
 * Every number, ID, count, date and time in the product renders with Western
 * digits 0–9, in Arabic as well as English.
 *
 * This is enforced HERE, at the formatter, and nowhere else: no fixture string
 * is hand-edited and no component formats a number by itself. `numberingSystem`
 * is passed explicitly rather than relying on a `-u-nu-latn` locale extension,
 * because the extension is silently dropped when a caller passes a plain locale
 * tag, and a dropped extension fails as Arabic-Indic digits — the exact defect
 * this rule exists to prevent. Passing both is deliberate belt-and-braces.
 */
export const NUMBERING_SYSTEM = 'latn';

/** `Intl.NumberFormat` pinned to Western digits. */
export function numberFormat(
  lang: Lang,
  options: Intl.NumberFormatOptions = {},
): Intl.NumberFormat {
  return new Intl.NumberFormat(LOCALE[lang], { ...options, numberingSystem: NUMBERING_SYSTEM });
}

/** `Intl.DateTimeFormat` pinned to Western digits. */
export function dateFormat(
  lang: Lang,
  options: Intl.DateTimeFormatOptions = {},
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE[lang], { ...options, numberingSystem: NUMBERING_SYSTEM });
}

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

/**
 * Avatar initials.
 *
 * Latin names give two capitals ("Eyad Sofian" → "ES", "eyad" → "E"). Arabic
 * names give one letter: two Arabic letters side by side join into a fragment
 * of a word ("سارة عبد الله" would read "سا"), which is neither initials nor
 * the name.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  const head = words[0];
  const tail = words[words.length - 1];
  if (head === undefined || tail === undefined) return '؟';
  const first = [...head].slice(0, 1).join('');
  if (words.length === 1 || ARABIC_SCRIPT.test(first)) return first.toLocaleUpperCase('en');
  return `${first}${[...tail].slice(0, 1).join('')}`.toLocaleUpperCase('en');
}

/** How many avatar tones the stylesheet defines (`--tone-0` … `--tone-7`). */
export const AVATAR_TONES = 8;

/**
 * A stable tone for a person, from their name or id: the same contact wears the
 * same colour on every screen and every reload, and different people spread
 * across the palette. FNV-1a, because it is tiny and distributes short strings
 * well; nothing about it is security-relevant.
 */
export function toneOf(seed: string): number {
  let hash = 0x811c9dc5;
  for (const glyph of seed) {
    hash ^= glyph.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AVATAR_TONES;
}

/**
 * The only customer-identifying string an unassigned queue card may show.
 * Business rule §4.1 allows a *masked display label* and nothing more, so the
 * real name never reaches the projection — this operates on it once, at the
 * projection boundary, and the full name is dropped there.
 */
export function maskDisplayLabel(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return '••••';
  return words
    .map((word) => {
      const glyphs = [...word];
      return `${glyphs.slice(0, 1).join('')}${'•'.repeat(Math.min(glyphs.length - 1, 3))}`;
    })
    .join(' ');
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact "time ago" for list rows: 3 د · 2 س · أمس · 12 سبتمبر. */
export function relativeTime(iso: string, now: Date, lang: Lang): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  const numbers = numberFormat(lang);
  if (elapsed < MINUTE) return lang === 'ar' ? 'الآن' : 'now';
  if (elapsed < HOUR) {
    const value = numbers.format(Math.floor(elapsed / MINUTE));
    return lang === 'ar' ? `${value} د` : `${value}m`;
  }
  if (elapsed < DAY) {
    const value = numbers.format(Math.floor(elapsed / HOUR));
    return lang === 'ar' ? `${value} س` : `${value}h`;
  }
  if (elapsed < 2 * DAY) return lang === 'ar' ? 'أمس' : 'yesterday';
  return dateFormat(lang, { day: 'numeric', month: 'short' }).format(new Date(iso));
}

/**
 * "Time until" for an instant that has not happened yet.
 *
 * `relativeTime` cannot be reused with a negated argument: it is past-only, and
 * a future instant falls into its first branch and reads as *now*. A snooze
 * that says a conversation is returning now when it returns tomorrow is worse
 * than no label — it is the one fact the operator pressed the button to set.
 *
 * Past the wake time it says so rather than counting up: a wake that has not
 * fired is a fact about the worker, not about the clock, and dressing it as
 * "-3m" would hide it.
 */
export function futureTime(iso: string, now: Date, lang: Lang): string {
  const remaining = new Date(iso).getTime() - now.getTime();
  const numbers = numberFormat(lang);
  if (remaining <= 0) return lang === 'ar' ? 'حان الوقت' : 'due';
  if (remaining < MINUTE) return lang === 'ar' ? 'خلال دقيقة' : 'in under a minute';
  if (remaining < HOUR) {
    const value = numbers.format(Math.floor(remaining / MINUTE));
    return lang === 'ar' ? `خلال ${value} د` : `in ${value}m`;
  }
  if (remaining < DAY) {
    const value = numbers.format(Math.floor(remaining / HOUR));
    return lang === 'ar' ? `خلال ${value} س` : `in ${value}h`;
  }
  // Past a day, the duration stops being useful and the date starts being: an
  // operator asking "when does this come back" wants a day, not "in 52h".
  return dateFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    .format(new Date(iso));
}

/** Wall clock inside the timeline. */
export function clockTime(iso: string, lang: Lang): string {
  return dateFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Day separator inside the timeline. */
export function dayLabel(iso: string, now: Date, lang: Lang): string {
  const date = new Date(iso);
  const startOfDay = (value: Date): number =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days === 0) return lang === 'ar' ? 'اليوم' : 'Today';
  if (days === 1) return lang === 'ar' ? 'أمس' : 'Yesterday';
  return dateFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

export function formatNumber(value: number, lang: Lang): string {
  return numberFormat(lang).format(value);
}

/** Duration cue for SLA / channel-window countdowns. */
export function durationLabel(minutes: number, lang: Lang): string {
  const numbers = numberFormat(lang);
  if (minutes < 60) {
    const value = numbers.format(Math.max(minutes, 0));
    return lang === 'ar' ? `${value} دقيقة` : `${value} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText =
    lang === 'ar' ? `${numbers.format(hours)} ساعة` : `${numbers.format(hours)} h`;
  if (rest === 0) return hourText;
  const restText =
    lang === 'ar' ? `${numbers.format(rest)} دقيقة` : `${numbers.format(rest)} min`;
  return `${hourText} ${restText}`;
}

/** Minutes between an ISO instant and `now`; negative once it is in the past. */
export function minutesUntil(iso: string, now: Date): number {
  return Math.round((new Date(iso).getTime() - now.getTime()) / MINUTE);
}

export function minutesSince(iso: string, now: Date): number {
  return Math.round((now.getTime() - new Date(iso).getTime()) / MINUTE);
}

/** `4 محادثات` / `4 conversations`, with correct Arabic plural categories. */
export function conversationCount(value: number, lang: Lang): string {
  const number = formatNumber(value, lang);
  if (lang === 'en') return value === 1 ? '1 conversation' : `${number} conversations`;
  if (value === 0) return 'لا محادثات';
  if (value === 1) return 'محادثة واحدة';
  if (value === 2) return 'محادثتان';
  if (value <= 10) return `${number} محادثات`;
  return `${number} محادثة`;
}
