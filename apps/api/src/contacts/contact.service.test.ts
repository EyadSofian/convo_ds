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
});
