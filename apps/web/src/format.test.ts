import { describe, expect, it } from 'vitest';
import {
  clockTime,
  conversationCount,
  dayLabel,
  durationLabel,
  formatNumber,
  initials,
  LOCALE,
  NUMBERING_SYSTEM,
  numberFormat,
  dateFormat,
  maskDisplayLabel,
  minutesSince,
  minutesUntil,
  relativeTime,
} from './format';

const NOW = new Date('2026-09-08T12:00:00.000Z');

describe('initials', () => {
  it('takes the first grapheme of the first and last word', () => {
    expect(initials('مريم خالد عبد الجواد')).toBe('ما');
    expect(initials('Lina Haddad')).toBe('LH');
  });

  it('handles a single word and blank input', () => {
    expect(initials('نور')).toBe('ن');
    expect(initials('   ')).toBe('؟');
  });
});

describe('maskDisplayLabel', () => {
  it('keeps only the first glyph of each word, capped at three dots', () => {
    expect(maskDisplayLabel('مريم خالد')).toBe('م••• خ•••');
    expect(maskDisplayLabel('Jo Ng')).toBe('J• N•');
  });

  it('never returns the original name', () => {
    const name = 'أحمد بدر الدين';
    expect(maskDisplayLabel(name)).not.toContain(name);
  });

  it('degrades safely on an empty name', () => {
    expect(maskDisplayLabel('')).toBe('••••');
  });
});

describe('relativeTime', () => {
  it('covers every bucket in Arabic', () => {
    expect(relativeTime('2026-09-08T11:59:30.000Z', NOW, 'ar')).toBe('الآن');
    expect(relativeTime('2026-09-08T11:57:00.000Z', NOW, 'ar')).toBe('3 د');
    expect(relativeTime('2026-09-08T09:00:00.000Z', NOW, 'ar')).toBe('3 س');
    expect(relativeTime('2026-09-07T09:00:00.000Z', NOW, 'ar')).toBe('أمس');
    expect(relativeTime('2026-09-01T09:00:00.000Z', NOW, 'ar')).toContain('1');
  });

  it('covers every bucket in English', () => {
    expect(relativeTime('2026-09-08T11:59:30.000Z', NOW, 'en')).toBe('now');
    expect(relativeTime('2026-09-08T11:57:00.000Z', NOW, 'en')).toBe('3m');
    expect(relativeTime('2026-09-08T09:00:00.000Z', NOW, 'en')).toBe('3h');
    expect(relativeTime('2026-09-07T09:00:00.000Z', NOW, 'en')).toBe('yesterday');
    expect(relativeTime('2026-09-01T09:00:00.000Z', NOW, 'en')).toMatch(/Sep/);
  });
});

describe('clockTime and dayLabel', () => {
  it('formats a wall clock in both languages', () => {
    expect(clockTime('2026-09-08T09:05:00.000Z', 'en')).toMatch(/\d{2}:\d{2}/);
    expect(clockTime('2026-09-08T09:05:00.000Z', 'ar')).toMatch(/\d|0/);
  });

  it('labels today, yesterday and older days', () => {
    expect(dayLabel(NOW.toISOString(), NOW, 'ar')).toBe('اليوم');
    expect(dayLabel(NOW.toISOString(), NOW, 'en')).toBe('Today');
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(dayLabel(yesterday, NOW, 'ar')).toBe('أمس');
    expect(dayLabel(yesterday, NOW, 'en')).toBe('Yesterday');
    const older = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(dayLabel(older, NOW, 'en')).toMatch(/September/);
  });
});

describe('numbers and durations', () => {
  it('formats numerals per locale', () => {
    expect(formatNumber(1234, 'en')).toBe('1,234');
    expect(formatNumber(5, 'ar')).toBe('5');
    expect(LOCALE.ar).toBe('ar-EG');
  });

  /**
   * The Western-digit rule (task §3) is a formatter guarantee, not a property
   * of the fixture strings. These assert the guarantee at its source, in the
   * locale that would otherwise produce Arabic-Indic digits.
   */
  it('renders every Arabic number, date and time with Western digits 0-9', () => {
    const arabicIndic = /[\u0660-\u0669\u06f0-\u06f9]/;

    expect(formatNumber(1234567, 'ar')).not.toMatch(arabicIndic);
    expect(formatNumber(1234567, 'ar')).toMatch(/^[0-9,.\u066b\u066c\u00a0\u202f]+$/);
    expect(clockTime('2026-09-08T09:05:00.000Z', 'ar')).not.toMatch(arabicIndic);
    expect(dayLabel('2026-09-01T09:05:00.000Z', NOW, 'ar')).not.toMatch(arabicIndic);
    expect(relativeTime('2026-09-08T11:45:00.000Z', NOW, 'ar')).not.toMatch(arabicIndic);
    expect(durationLabel(150, 'ar')).not.toMatch(arabicIndic);
    expect(conversationCount(24, 'ar')).not.toMatch(arabicIndic);
  });

  it('pins the numbering system explicitly, not through a locale extension', () => {
    // A caller that drops the `-u-nu-latn` extension must still get 0-9: the
    // resolved options are what the browser actually used.
    expect(numberFormat('ar').resolvedOptions().numberingSystem).toBe('latn');
    expect(dateFormat('ar').resolvedOptions().numberingSystem).toBe('latn');
    expect(numberFormat('en').resolvedOptions().numberingSystem).toBe('latn');
    expect(NUMBERING_SYSTEM).toBe('latn');
  });

  it('formats sub-hour, whole-hour and mixed durations', () => {
    expect(durationLabel(41, 'en')).toBe('41 min');
    expect(durationLabel(41, 'ar')).toBe('41 دقيقة');
    expect(durationLabel(120, 'en')).toBe('2 h');
    expect(durationLabel(120, 'ar')).toBe('2 ساعة');
    expect(durationLabel(150, 'en')).toBe('2 h 30 min');
    expect(durationLabel(150, 'ar')).toBe('2 ساعة 30 دقيقة');
  });

  it('never renders a negative duration', () => {
    expect(durationLabel(-9, 'en')).toBe('0 min');
  });
});

describe('minutesUntil and minutesSince', () => {
  it('are signed mirrors of each other', () => {
    const future = new Date(NOW.getTime() + 30 * 60_000).toISOString();
    expect(minutesUntil(future, NOW)).toBe(30);
    expect(minutesSince(future, NOW)).toBe(-30);
  });
});

describe('conversationCount', () => {
  it('uses Arabic plural categories', () => {
    expect(conversationCount(0, 'ar')).toBe('لا محادثات');
    expect(conversationCount(1, 'ar')).toBe('محادثة واحدة');
    expect(conversationCount(2, 'ar')).toBe('محادثتان');
    expect(conversationCount(7, 'ar')).toBe('7 محادثات');
    expect(conversationCount(24, 'ar')).toBe('24 محادثة');
  });

  it('uses English singular and plural', () => {
    expect(conversationCount(1, 'en')).toBe('1 conversation');
    expect(conversationCount(4, 'en')).toBe('4 conversations');
  });
});
