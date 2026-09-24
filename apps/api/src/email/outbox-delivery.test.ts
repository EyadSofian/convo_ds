import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '@convo/domain';
import type { ApiConfig } from '../config.js';
import type { ErrorDetail } from '@convo/contracts';
import { readEmailLocale } from './email-config.js';
import { OutboxInvitationDelivery, OutboxRecoveryDelivery } from './outbox-delivery.js';

/**
 * The two port bindings, and the one decision they make: which language the
 * message renders in.
 *
 * There is no per-person language preference, and guessing one from an
 * `Accept-Language` header would be wrong for exactly the case that matters —
 * an invitation is read by somebody who has never visited this installation. So
 * it is the installation default, and this pins that both arms work.
 */

function recorder() {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const sql: SqlExecutor = {
    query: <R>(text: string, values?: readonly unknown[]) => {
      queries.push({ text, values: values ?? [] });
      return Promise.resolve({ rows: [{ id: 'delivery-1' } as R], rowCount: 1 });
    },
  };
  return { sql, queries };
}

function configWithLocale(emailLocale: 'ar' | 'en'): ApiConfig {
  // The interface default is deliberately the other language: emails follow
  // their own setting, not the workspace's.
  return { emailLocale, defaultLocale: emailLocale === 'en' ? 'ar' : 'en' } as unknown as ApiConfig;
}

describe('the locale a queued email renders in', () => {
  it.each(['ar', 'en'] as const)('uses the email language, %s, for an invitation', async (locale) => {
    const { sql, queries } = recorder();
    await new OutboxInvitationDelivery(configWithLocale(locale)).deliver(sql, {
      tenantId: '00000000-0000-4000-8000-000000000001',
      invitationId: '00000000-0000-4000-8000-000000000002',
      email: 'nadia@digital-school.example',
      token: 'a'.repeat(43),
      tenantName: 'Digital School',
      roleName: 'Agent',
      expiresAt: new Date('2026-09-24T09:00:00.000Z'),
    });
    expect(queries[0]?.values[4]).toBe(locale);
    // The invitation's own id is the idempotency key, so pressing "invite
    // again" mints a new row rather than colliding with the old one.
    expect(queries[0]?.values[2]).toBe('00000000-0000-4000-8000-000000000002');
  });

  it.each(['ar', 'en'] as const)('uses it for recovery too, with no company attributed', async (locale) => {
    const { sql, queries } = recorder();
    await new OutboxRecoveryDelivery(configWithLocale(locale)).deliver(sql, {
      challengeId: '00000000-0000-4000-8000-000000000003',
      email: 'owner@digital-school.example',
      token: 'b'.repeat(43),
      expiresAt: new Date('2026-09-17T11:00:00.000Z'),
    });
    expect(queries[0]?.values[4]).toBe(locale);
    // Recovery belongs to a person, not to a company.
    expect(queries[0]?.values[0]).toBeNull();
  });
});

describe('the email language setting', () => {
  it('is English unless set, accepts en or ar, and refuses anything else', () => {
    const issues: ErrorDetail[] = [];
    expect(readEmailLocale({}, issues)).toBe('en');
    expect(readEmailLocale({ CONVO_EMAIL_LOCALE: ' ' }, issues)).toBe('en');
    expect(readEmailLocale({ CONVO_EMAIL_LOCALE: 'AR' }, issues)).toBe('ar');
    expect(readEmailLocale({ CONVO_EMAIL_LOCALE: 'en' }, issues)).toBe('en');
    expect(issues).toEqual([]);
    expect(readEmailLocale({ CONVO_EMAIL_LOCALE: 'fr' }, issues)).toBe('en');
    expect(issues.map((issue) => issue.field)).toEqual(['CONVO_EMAIL_LOCALE']);
  });
});
