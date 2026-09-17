import { describe, expect, it } from 'vitest';
import { asExecutor, withTenant } from '../../packages/database/src/index.js';
import { applyInstallationConfig } from '../../packages/domain/src/index.js';
import {
  createScratchDatabase,
  migrateScratch,
  scratchRuntimePool,
  superuserPool,
} from '../support/scratch.js';
import { seedVolume } from './seed.js';

/**
 * `EXPLAIN ANALYZE` on the queries the load run showed to be expensive.
 *
 * This exists because a load test tells you *that* something is slow and never
 * *why*. The first attempt at fixing contact search added a trigram index on the
 * strength of a plausible-sounding argument about leading wildcards, and it
 * changed the measured latency by under 3% — which is the difference between a
 * diagnosis and a guess that happened to sound like one.
 *
 * The plans printed here are the diagnosis. They run against the same seeded
 * volume the load run uses, so the numbers are comparable.
 */

const TENANT_SQL = `SELECT id::text FROM tenants LIMIT 1`;

describe('query plans at volume', () => {
  it('prints the plan for contact search and for the conversation list', async () => {
    const names = await createScratchDatabase('convo_explain');
    await migrateScratch(names);
    const pool = scratchRuntimePool(names, 4);
    const admin = superuserPool(names.database, 2);

    try {
      // The tenant insert trips a trigger without it.
      await applyInstallationConfig(asExecutor(pool), 'saas');
      // A company to own the rows. Created directly: this file is about plans,
      // not about the bootstrap path.
      const tenant = await admin.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, status) VALUES ('Explain', 'explain', 'active')
         RETURNING id::text`,
      );
      const tenantId = tenant.rows[0]?.id ?? '';
      expect(tenantId).not.toBe('');

      await seedVolume(pool, admin, tenantId, {
        conversations: 10_000,
        contacts: 10_000,
        messagesPerConversation: 2,
      });

      const plans: string[] = [];
      await withTenant(pool, tenantId, async (client) => {
        const check = await client.query<{ id: string }>(TENANT_SQL);
        expect(check.rowCount).toBe(1);

        for (const [label, sql, params] of queries(tenantId)) {
          const explained = await client.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (ANALYZE, BUFFERS, COSTS) ${sql}`,
            params,
          );
          plans.push(
            `\n=== ${label} ===\n${explained.rows.map((row) => row['QUERY PLAN']).join('\n')}`,
          );
        }
      });

      process.stdout.write(`${plans.join('\n')}\n`);
      expect(plans.length).toBeGreaterThan(0);
    } finally {
      await pool.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 600_000);
});

/**
 * The queries, reduced to the shape the service actually issues.
 *
 * The scope predicates are pinned to the tenant-wide case, which is what an
 * Owner sees and therefore the widest and most expensive one.
 */
function queries(tenantId: string): readonly [string, string, unknown[]][] {
  return [
    [
      'contact search — infix LIKE only',
      `SELECT id::text, display_name FROM contacts
        WHERE deleted_at IS NULL AND search_name LIKE '%' || $1 || '%'
        ORDER BY created_at DESC, id LIMIT 200`,
      ['nadia'],
    ],
    [
      'contact search — full list query, tenant reach',
      `SELECT id::text, display_name, attributes, version, created_at
         FROM contacts
        WHERE deleted_at IS NULL
          AND ($1::text IS NULL OR search_name LIKE '%' || $1 || '%')
          AND (cardinality($2::uuid[]) = 0 OR (
            SELECT count(DISTINCT cl.label_id) FROM contact_labels cl
             WHERE cl.contact_id = contacts.id AND cl.removed_at IS NULL
               AND cl.label_id = ANY($2::uuid[])
          ) = cardinality($2::uuid[]))
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM contact_custom_field_values cfv
             WHERE cfv.contact_id = contacts.id AND cfv.field_id = $3
               AND (($5::boolean AND cfv.search_value LIKE '%' || $4 || '%')
                 OR (NOT $5::boolean AND cfv.search_value = $4))
          ))
          AND ($6::text = 'tenant' OR true)
        ORDER BY created_at DESC, id
        LIMIT 200`,
      ['nadia', [], null, '', false, 'tenant'],
    ],
    [
      'contact list — no search term',
      `SELECT id::text, display_name FROM contacts
        WHERE deleted_at IS NULL AND ($1::text IS NULL OR search_name LIKE '%' || $1 || '%')
        ORDER BY created_at DESC, id LIMIT 200`,
      [null],
    ],
    [
      'conversation list — recent first',
      `SELECT id::text, peer_identity, status, last_activity_at
         FROM conversations
        WHERE tenant_id = $1
        ORDER BY last_activity_at DESC
        LIMIT 50`,
      [tenantId],
    ],
  ];
}
