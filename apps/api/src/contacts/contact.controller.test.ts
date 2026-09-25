import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { AuthenticatedSession } from '../auth/auth.service.js';
import type { ContactService } from './contact.service.js';
import { ContactController } from './contact.controller.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const connectionId = '22222222-2222-4222-8222-222222222222';
const session = { userId: 'user-1' } as AuthenticatedSession;

describe('ContactController.create', () => {
  it('requires the normal authenticated, CSRF-protected endpoint and passes an explicit channel identity', async () => {
    const auth = {
      authenticate: vi.fn().mockResolvedValue(session),
      requireCsrf: vi.fn(),
    };
    const contacts = { create: vi.fn().mockResolvedValue({ id: 'contact-1' }) };
    const controller = new ContactController(auth as never, contacts as unknown as ContactService);
    const request = { headers: { cookie: 'session=cookie', 'x-csrf-token': 'csrf' }, id: 'request-1' } as unknown as FastifyRequest;

    await expect(controller.create(tenantId, {
      displayName: '  Sara  ', connectionId, externalId: '  201000000000  ',
    }, 'csrf', request)).resolves.toEqual({ data: { id: 'contact-1' }, request_id: 'request-1' });
    expect(auth.requireCsrf).toHaveBeenCalledOnce();
    expect(contacts.create).toHaveBeenCalledWith(session, tenantId, {
      displayName: 'Sara', connectionId, externalId: '201000000000',
    });
  });

  it('rejects missing or malformed identity fields before invoking the service', async () => {
    const auth = { authenticate: vi.fn().mockResolvedValue(session), requireCsrf: vi.fn() };
    const contacts = { create: vi.fn() };
    const controller = new ContactController(auth as never, contacts as unknown as ContactService);
    const request = { headers: { cookie: 'session=cookie' }, id: 'request-1' } as unknown as FastifyRequest;
    await expect(controller.create(tenantId, { displayName: 'Sara', connectionId: 'bad', externalId: '' }, 'csrf', request))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(contacts.create).not.toHaveBeenCalled();
  });
});

describe('ContactController bulk contact tools', () => {
  it('validates and forwards a connection-bound CSV import under CSRF protection', async () => {
    const auth = { authenticate: vi.fn().mockResolvedValue(session), requireCsrf: vi.fn() };
    const contacts = { importBatch: vi.fn().mockResolvedValue({ created: 1 }) };
    const controller = new ContactController(auth as never, contacts as unknown as ContactService);
    const request = { headers: { cookie: 'session=cookie' }, id: 'request-2' } as unknown as FastifyRequest;
    await expect(controller.import(tenantId, {
      connectionId, rows: [{ displayName: 'Sara', externalId: '201000000000' }],
    }, 'csrf', request)).resolves.toEqual({ data: { created: 1 }, request_id: 'request-2' });
    expect(auth.requireCsrf).toHaveBeenCalledOnce();
    expect(contacts.importBatch).toHaveBeenCalledWith(session, tenantId, {
      connectionId, rows: [{ displayName: 'Sara', externalId: '201000000000' }],
    });
  });

  it('rejects malformed or oversized imports before any write', async () => {
    const auth = { authenticate: vi.fn().mockResolvedValue(session), requireCsrf: vi.fn() };
    const contacts = { importBatch: vi.fn() };
    const controller = new ContactController(auth as never, contacts as unknown as ContactService);
    const request = { headers: { cookie: 'session=cookie' }, id: 'request-3' } as unknown as FastifyRequest;
    await expect(controller.import(tenantId, { connectionId, rows: Array.from({ length: 501 }, () => ({ displayName: 'Sara', externalId: '201' })) }, 'csrf', request))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(controller.import(tenantId, { connectionId, rows: [{ displayName: '', externalId: '201' }] }, 'csrf', request))
      .rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    expect(contacts.importBatch).not.toHaveBeenCalled();
  });
});
