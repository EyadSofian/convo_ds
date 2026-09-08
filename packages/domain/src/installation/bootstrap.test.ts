import { describe, expect, it } from 'vitest';
import { fakeTransaction, type FakeSqlRule } from '../testing/fake-sql.js';
import { bootstrapInstallation, type InstallationBootstrapInput } from './bootstrap.js';

const validInput: InstallationBootstrapInput = {
  companyName: 'Acme Support',
  companySlug: 'acme',
  ownerEmail: 'owner@acme.example',
  ownerPasswordHash: '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA',
};

const HAPPY_PATH: FakeSqlRule[] = [
  { match: /UPDATE installations/, rows: [{ id: 'installation-1' }] },
  { match: /INSERT INTO roles/, rows: [{ id: 'role-1' }] },
  { match: /INSERT INTO memberships/, rows: [{ id: 'membership-1' }] },
];

function ids(): () => string {
  const queue = ['tenant-1', 'user-1'];
  let index = 0;
  return () => queue[index++] ?? `extra-${index}`;
}

describe('bootstrapInstallation (MODE-03)', () => {
  it('creates one company, one owner and the full permission set', async () => {
    const transaction = fakeTransaction(HAPPY_PATH);
    const result = await bootstrapInstallation(
      { transaction: transaction.run, newId: ids() },
      validInput,
    );

    expect(result).toEqual({
      status: 'created',
      tenantId: 'tenant-1',
      ownerUserId: 'user-1',
      ownerRoleId: 'role-1',
      membershipId: 'membership-1',
    });
    expect(transaction.tenantIds).toEqual(['tenant-1']);
  });

  /**
   * Ordering is the concurrency argument, so it is asserted rather than
   * assumed: the one-time flag is claimed by a conditional UPDATE before any
   * row is written, inside the same transaction as those writes.
   */
  it('claims the one-time flag before it writes anything', async () => {
    const transaction = fakeTransaction(HAPPY_PATH);
    await bootstrapInstallation({ transaction: transaction.run, newId: ids() }, validInput);

    const statements = transaction.sql.calls.map((call) => call.text.replace(/\s+/g, ' ').trim());
    expect(statements[0]).toContain('UPDATE installations');
    expect(statements[0]).toContain("bootstrap_state = 'pending'");
    expect(statements.slice(1).map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO users',
      'INSERT INTO tenants',
      'INSERT INTO roles',
      'INSERT INTO role_permissions',
      'INSERT INTO memberships',
      'INSERT INTO membership_scopes',
    ]);
  });

  it('grants the owner every permission by key, not by role name', async () => {
    const transaction = fakeTransaction(HAPPY_PATH);
    await bootstrapInstallation({ transaction: transaction.run, newId: ids() }, validInput);

    const grant = transaction.sql.calls.find((call) => call.text.includes('role_permissions'));
    expect(grant?.text).toContain('SELECT $1, $2, key FROM permissions');
    expect(grant?.values).toEqual(['tenant-1', 'role-1']);
  });

  it('scopes the owner membership to the whole tenant', async () => {
    const transaction = fakeTransaction(HAPPY_PATH);
    await bootstrapInstallation({ transaction: transaction.run, newId: ids() }, validInput);
    const scope = transaction.sql.calls.find((call) => call.text.includes('membership_scopes'));
    expect(scope?.values).toEqual(['tenant-1', 'membership-1']);
  });

  it('rejects a second call harmlessly and writes nothing', async () => {
    const transaction = fakeTransaction([
      { match: /SELECT id FROM installations/, rows: [{ id: 'installation-1' }] },
    ]);
    const result = await bootstrapInstallation(
      { transaction: transaction.run, newId: ids() },
      validInput,
    );

    expect(result).toMatchObject({
      status: 'rejected',
      code: 'installation_already_bootstrapped',
    });
    const attemptedWrites = transaction.sql.calls.filter((call) =>
      call.text.includes('INSERT INTO'),
    );
    expect(attemptedWrites).toEqual([]);
  });

  it('distinguishes an unconfigured installation from an already used one', async () => {
    const transaction = fakeTransaction();
    const result = await bootstrapInstallation(
      { transaction: transaction.run, newId: ids() },
      validInput,
    );
    expect(result).toMatchObject({ status: 'rejected', code: 'installation_not_configured' });
  });

  describe('input validation happens before any transaction opens', () => {
    it.each([
      ['a blank company name', { companyName: '   ' }, 'companyName:required'],
      ['an over-long company name', { companyName: 'x'.repeat(81) }, 'companyName:too_long'],
      ['an uppercase slug', { companySlug: 'Acme' }, 'companySlug:malformed'],
      ['a slug with a leading hyphen', { companySlug: '-acme' }, 'companySlug:malformed'],
      ['a slug with a trailing hyphen', { companySlug: 'acme-' }, 'companySlug:malformed'],
      ['an over-long slug', { companySlug: 'a'.repeat(41) }, 'companySlug:malformed'],
      ['an empty slug', { companySlug: '' }, 'companySlug:malformed'],
      ['an email with no domain dot', { ownerEmail: 'owner@localhost' }, 'ownerEmail:malformed'],
      ['an email with two at signs', { ownerEmail: 'a@b@c.example' }, 'ownerEmail:malformed'],
      ['an email with a space', { ownerEmail: 'owner @acme.example' }, 'ownerEmail:malformed'],
      ['an email with no local part', { ownerEmail: '@acme.example' }, 'ownerEmail:malformed'],
      ['an empty email', { ownerEmail: '' }, 'ownerEmail:malformed'],
      ['an unbounded email', { ownerEmail: `${'a'.repeat(250)}@acme.example` }, 'ownerEmail:malformed'],
      [
        'a plaintext password where a hash belongs',
        { ownerPasswordHash: 'correct horse battery staple' },
        'ownerPasswordHash:not_a_supported_hash',
      ],
      ['an unrecognised hash format', { ownerPasswordHash: '$sha1$abc' }, 'ownerPasswordHash:not_a_supported_hash'],
    ])('rejects %s', async (_label, patch, expected) => {
      const transaction = fakeTransaction(HAPPY_PATH);
      const result = await bootstrapInstallation(
        { transaction: transaction.run, newId: ids() },
        { ...validInput, ...patch },
      );

      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') {
        throw new Error('unreachable');
      }
      expect(result.code).toBe('invalid_input');
      expect(result.details.map((d) => `${d.field}:${d.code}`)).toContain(expected);
      // Nothing was attempted: no transaction, therefore no claimed flag.
      expect(transaction.tenantIds).toEqual([]);
      expect(transaction.sql.calls).toEqual([]);
    });

    it('accepts a bcrypt hash as well as argon2', async () => {
      const transaction = fakeTransaction(HAPPY_PATH);
      const result = await bootstrapInstallation(
        { transaction: transaction.run, newId: ids() },
        { ...validInput, ownerPasswordHash: '$2b$12$abcdefghijklmnopqrstuv' },
      );
      expect(result.status).toBe('created');
    });

    it('trims the values it stores', async () => {
      const transaction = fakeTransaction(HAPPY_PATH);
      await bootstrapInstallation(
        { transaction: transaction.run, newId: ids() },
        {
          ...validInput,
          companyName: '  Acme Support  ',
          companySlug: ' acme ',
          ownerEmail: ' owner@acme.example ',
        },
      );
      const userInsert = transaction.sql.calls.find((call) => call.text.includes('INTO users'));
      const tenantInsert = transaction.sql.calls.find((call) => call.text.includes('INTO tenants'));
      expect(userInsert?.values[1]).toBe('owner@acme.example');
      expect(tenantInsert?.values).toEqual(['tenant-1', 'Acme Support', 'acme']);
    });
  });

  describe('impossible database responses fail loudly', () => {
    it('fails if the owner role insert returns no id', async () => {
      const transaction = fakeTransaction([
        { match: /UPDATE installations/, rows: [{ id: 'installation-1' }] },
      ]);
      await expect(
        bootstrapInstallation({ transaction: transaction.run, newId: ids() }, validInput),
      ).rejects.toThrow('Owner role insert returned no id');
    });

    it('fails if the owner membership insert returns no id', async () => {
      const transaction = fakeTransaction([
        { match: /UPDATE installations/, rows: [{ id: 'installation-1' }] },
        { match: /INSERT INTO roles/, rows: [{ id: 'role-1' }] },
      ]);
      await expect(
        bootstrapInstallation({ transaction: transaction.run, newId: ids() }, validInput),
      ).rejects.toThrow('Owner membership insert returned no id');
    });
  });
});
