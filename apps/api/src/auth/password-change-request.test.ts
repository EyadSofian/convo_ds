import { describe, expect, it } from 'vitest';
import { parsePasswordChange } from './password-change-request.js';

describe('parsePasswordChange', () => {
  const valid = {
    currentPassword: 'current password value',
    newPassword: 'new password value 123',
    confirmPassword: 'new password value 123',
  };

  it('accepts the exact credential shape without trimming passwords', () => {
    expect(parsePasswordChange(valid)).toEqual({ ok: true, value: valid });
  });

  it('rejects malformed bodies, unexpected fields and short credentials', () => {
    expect(parsePasswordChange(null)).toMatchObject({ ok: false, details: [{ field: 'body' }] });
    const parsed = parsePasswordChange({ ...valid, newPassword: 'short', confirmPassword: 'different', extra: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.details.map(({ field, code }) => ({ field, code }))).toEqual(expect.arrayContaining([
        { field: 'extra', code: 'unexpected' },
        { field: 'newPassword', code: 'too_short' },
        { field: 'confirmPassword', code: 'too_short' },
        { field: 'confirmPassword', code: 'mismatch' },
      ]));
    }
  });

  it('rejects missing, non-string and overlong credentials', () => {
    const parsed = parsePasswordChange({
      currentPassword: 42,
      newPassword: 'x'.repeat(513),
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.details.map(({ field, code }) => ({ field, code }))).toEqual(expect.arrayContaining([
        { field: 'currentPassword', code: 'not_a_string' },
        { field: 'newPassword', code: 'too_long' },
        { field: 'confirmPassword', code: 'required' },
      ]));
    }
  });
});
