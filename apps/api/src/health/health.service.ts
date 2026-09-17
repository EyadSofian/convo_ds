import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, API_POOL } from '../tokens.js';

/**
 * Liveness and readiness, and the difference between them.
 *
 * Getting this pair wrong is one of the most common ways a deployment makes an
 * incident worse, so both directions are stated here:
 *
 * - **Liveness** answers "is this process still a process". It touches nothing
 *   external. If liveness consulted the database, a database blip would make
 *   the platform kill and restart every healthy API instance at once —
 *   converting a recoverable dependency failure into a full outage, at the
 *   exact moment the dependency is least able to take a thundering herd of
 *   reconnections.
 *
 * - **Readiness** answers "should traffic come here now". It checks the
 *   dependencies this process genuinely cannot serve a request without. For the
 *   API that is PostgreSQL, and **only** PostgreSQL: not the email provider,
 *   not a channel provider, not a broker. An installation whose Resend key has
 *   expired should still serve the inbox; taking the whole API out of rotation
 *   because a third party is down is a self-inflicted outage.
 *
 * Configuration validity is deliberately not checked here either. It is checked
 * at boot, where a bad value stops the process from starting at all — which is
 * the correct moment, because a process that cannot work should never reach the
 * point of being asked whether it is ready.
 */

export interface ReadinessReport {
  readonly ready: boolean;
  readonly role: string;
  readonly checks: readonly ReadinessCheck[];
}

export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly durationMs: number;
  /** A typed code, never a driver message: those carry host names and roles. */
  readonly code?: string;
}

/**
 * Longer than a healthy query, far shorter than a platform probe timeout.
 *
 * A readiness check that can hang is a readiness check that reports nothing.
 */
const DATABASE_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    @Inject(API_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const database = await this.checkDatabase();
    return {
      ready: database.ok,
      role: this.config.processRole,
      checks: [database],
    };
  }

  private async checkDatabase(): Promise<ReadinessCheck> {
    const started = Date.now();
    try {
      await Promise.race([
        this.pool.query('SELECT 1'),
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('timeout'));
          }, DATABASE_TIMEOUT_MS).unref();
        }),
      ]);
      return { name: 'database', ok: true, durationMs: Date.now() - started };
    } catch (error) {
      return {
        name: 'database',
        ok: false,
        durationMs: Date.now() - started,
        // The driver's message names the host, port and role it tried. None of
        // that belongs in an unauthenticated response.
        code: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'unavailable',
      };
    }
  }
}
