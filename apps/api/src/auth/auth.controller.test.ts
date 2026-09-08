import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller.js';
import type { AuthService, LoginOutcome } from './auth.service.js';

describe('AuthController header normalization', () => {
  it('does not persist an ambiguous user-agent header', async () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const outcome: LoginOutcome = {
      principal: {
        sessionId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        email: 'owner@example.test',
        csrfHash: 'hash',
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now,
      },
      tokens: { session: 'session-token', csrf: 'csrf-token' },
    };
    const auth = {
      login: vi.fn().mockResolvedValue(outcome),
      secureCookies: false,
      sessionTtlSeconds: 60,
    } as unknown as AuthService;
    const send = vi.fn().mockResolvedValue(undefined);
    const reply = {
      header: vi.fn(),
      status: vi.fn().mockReturnValue({ send }),
    } as unknown as FastifyReply;
    const request = {
      id: 'request-1',
      ip: '127.0.0.1',
      headers: { 'user-agent': ['first', 'second'] },
    } as unknown as FastifyRequest;

    await new AuthController(auth).login(
      { email: 'owner@example.test', password: 'password' },
      request,
      reply,
    );

    expect(auth.login).toHaveBeenCalledWith(
      { email: 'owner@example.test', password: 'password' },
      '127.0.0.1',
      undefined,
    );
    expect(send).toHaveBeenCalledOnce();
  });
});
