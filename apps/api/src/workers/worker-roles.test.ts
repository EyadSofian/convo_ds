import { describe, expect, it, vi } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { ChannelDispatcherService } from '../channels/dispatcher.service.js';
import { ChannelNormalizationService } from '../channels/normalization.service.js';
import { LifecycleService } from '../conversations/lifecycle.service.js';
import { RoutingService } from '../conversations/routing.service.js';
import { tickFor } from './worker-roles.js';

describe('inbound worker profile queue', () => {
  it('drains due profile work even when no new inbound message arrived', async () => {
    const normalizer = {
      pendingTenants: vi.fn().mockResolvedValue([]),
      pendingProfileTenants: vi.fn().mockResolvedValue(['tenant-1']),
      drainProfiles: vi.fn().mockResolvedValue(2),
    };
    const services = new Map<unknown, unknown>([
      [ChannelNormalizationService, normalizer],
      [ChannelDispatcherService, { reconcileReceipts: vi.fn() }],
      [LifecycleService, { sweepDueWakes: vi.fn().mockResolvedValue(0) }],
      [RoutingService, { sweepExpiredHandoffs: vi.fn().mockResolvedValue(0) }],
    ]);
    const app = { get: (kind: unknown) => services.get(kind) } as INestApplicationContext;
    await expect(tickFor('worker-inbound', { app, concurrency: 3 })()).resolves.toEqual({ handled: 2 });
    expect(normalizer.drainProfiles).toHaveBeenCalledWith('tenant-1', 6);
  });
});
