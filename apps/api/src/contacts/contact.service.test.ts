import { describe, expect, it, vi } from 'vitest';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import { ContactService } from './contact.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

function serviceWithIdentityRace() {
  const sql = {
    query: vi.fn(async (statement: string) => {
      if (statement.includes('FROM channel_connections')) return { rows: [{ kind: 'whatsapp' }] };
      if (statement.includes('FROM contact_identities')) return { rows: [] };
      if (statement.includes('INSERT INTO contacts')) return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };
      if (statement.includes('INSERT INTO contact_identities')) throw Object.assign(new Error('unique'), { code: '23505' });
      throw new Error(`Unexpected query: ${statement}`);
    }),
  };
  const authorization = {
    assertTenantId: vi.fn(),
    withPrincipal: async (_session: unknown, _tenant: string, work: (context: { sql: typeof sql }) => unknown) => work({ sql }),
    requirePermission: vi.fn(async () => ({ membershipId: 'membership-1' })),
  };
  return new ContactService(authorization as unknown as AuthorizationService);
}

describe('ContactService concurrent identity conflicts', () => {
  it('turns a create identity uniqueness race into a safe conflict', async () => {
    const service = serviceWithIdentityRace();
    await expect(service.create({} as AuthenticatedSession, TENANT, {
      displayName: 'Sara', connectionId: CONNECTION, externalId: 'wa-1',
    })).rejects.toMatchObject({ status: 409, code: 'contact_identity_exists' });
  });

  it('rolls back a batch and returns a safe conflict if import wins a race', async () => {
    const service = serviceWithIdentityRace();
    await expect(service.importBatch({} as AuthenticatedSession, TENANT, {
      connectionId: CONNECTION, rows: [{ displayName: 'Sara', externalId: 'wa-1' }],
    })).rejects.toMatchObject({ status: 409, code: 'contact_import_conflicts' });
  });

  it('does not create contacts for a disconnected/missing connection', async () => {
    const sql = { query: vi.fn(async () => ({ rows: [] })) };
    const authorization = {
      assertTenantId: vi.fn(),
      withPrincipal: async (_session: unknown, _tenant: string, work: (context: { sql: typeof sql }) => unknown) => work({ sql }),
      requirePermission: vi.fn(async () => ({ membershipId: 'membership-1' })),
    };
    const service = new ContactService(authorization as unknown as AuthorizationService);
    await expect(service.create({} as AuthenticatedSession, TENANT, { displayName: 'Sara', connectionId: CONNECTION, externalId: 'wa-1' }))
      .rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
    await expect(service.importBatch({} as AuthenticatedSession, TENANT, { connectionId: CONNECTION, rows: [{ displayName: 'Sara', externalId: 'wa-1' }] }))
      .rejects.toMatchObject({ status: 404, code: 'resource_not_found' });
  });

  it('detects repeated identities within a batch before writing any contact', async () => {
    const sql = {
      query: vi.fn(async (statement: string) => statement.includes('FROM channel_connections')
        ? { rows: [{ kind: 'whatsapp' }] }
        : statement.includes('FROM contact_identities') ? { rows: [] } : { rows: [] }),
    };
    const authorization = {
      assertTenantId: vi.fn(),
      withPrincipal: async (_session: unknown, _tenant: string, work: (context: { sql: typeof sql }) => unknown) => work({ sql }),
      requirePermission: vi.fn(async () => ({ membershipId: 'membership-1' })),
    };
    const service = new ContactService(authorization as unknown as AuthorizationService);
    await expect(service.importBatch({} as AuthenticatedSession, TENANT, {
      connectionId: CONNECTION,
      rows: [{ displayName: 'Sara', externalId: 'wa-1' }, { displayName: 'Sara 2', externalId: 'wa-1' }],
    })).rejects.toMatchObject({ status: 409, code: 'contact_import_conflicts' });
    expect(sql.query.mock.calls.some(([statement]) => statement.includes('INSERT INTO contacts'))).toBe(false);
  });

  it('bounds scoped exports and renders absent identity fields as empty CSV cells', async () => {
    const principal = {
      membershipId: 'membership-1', membershipStatus: 'active', tenantStatus: 'active',
      grants: { 'contact.read': 'scoped', 'contact.export': 'tenant' }, delegationCeiling: null,
      scopes: [
        { type: 'team', id: null }, { type: 'team', id: '33333333-3333-4333-8333-333333333333' },
        { type: 'inbox', id: null }, { type: 'inbox', id: '44444444-4444-4444-8444-444444444444' },
      ],
    };
    const authorizationFor = (rows: readonly unknown[]) => {
      const sql = { query: vi.fn(async () => ({ rows })) };
      const authorization = {
        withPrincipal: async (_session: unknown, _tenant: string, work: (context: { sql: typeof sql; principal: typeof principal }) => unknown) => work({ sql, principal }),
        requirePermission: vi.fn(async () => principal),
      };
      return { service: new ContactService(authorization as unknown as AuthorizationService), sql };
    };
    const tooLarge = authorizationFor(Array.from({ length: 10_001 }, () => ({ display_name: 'Sara', kind: null, scope_id: null, external_id: null })));
    await expect(tooLarge.service.exportCsv({} as AuthenticatedSession, TENANT)).rejects.toMatchObject({ status: 413, code: 'contact_export_too_large' });
    const normal = authorizationFor([{ display_name: 'Sara', kind: null, scope_id: null, external_id: null }]);
    const exported = await normal.service.exportCsv({} as AuthenticatedSession, TENANT);
    expect(exported.content).toContain('"Sara","","",""');
  });

  it('refuses export when the principal has export permission but no readable contact scope', async () => {
    const principal = {
      membershipId: 'membership-1', membershipStatus: 'active', tenantStatus: 'active',
      grants: { 'contact.export': 'tenant' }, delegationCeiling: null, scopes: [],
    };
    const sql = { query: vi.fn(async () => ({ rows: [] })) };
    const authorization = {
      withPrincipal: async (_session: unknown, _tenant: string, work: (context: { sql: typeof sql; principal: typeof principal }) => unknown) => work({ sql, principal }),
      requirePermission: vi.fn(async () => principal),
    };
    const service = new ContactService(authorization as unknown as AuthorizationService);
    await expect(service.exportCsv({} as AuthenticatedSession, TENANT)).rejects.toMatchObject({ status: 403 });
    expect(sql.query).not.toHaveBeenCalled();
  });
});
