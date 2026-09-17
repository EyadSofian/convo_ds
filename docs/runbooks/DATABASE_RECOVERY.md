# Runbook: database backup and recovery

## Objectives and current evidence

| Item | State |
| --- | --- |
| RPO | PITR enabled; daily and weekly recovery points. Exact continuous-PITR window is provider-managed and must be confirmed contractually. |
| RTO | Two-hour operating target; not yet measured at customer volume. |
| Daily retention | 6 days (`acf3b9e6-50b7-4d08-beae-5c187fbea9a1`) |
| Weekly retention | 27 days (`ddbd9e08-3500-417a-842d-63dc77f983d4`) |
| Release recovery point | `80951af4-c581-4d5e-a8df-93dad3ce5091`, `pre-convo-v1.0.0-rc.1`, 929 MB referenced |
| Owner | Operator holding Railway production access; still a human single point of failure |

Production PITR reports `enabled: true`, `bucketWired: true` and live storage
available. The CLI's deeper archive/coverage probe could not authenticate with
its built-in SSH path even though ordinary Railway SSH is operational; do not
translate that unavailable probe into a false coverage claim.

## What has been proven

`pnpm test:recovery` builds a populated installation, creates a logical backup,
restores into an isolated database, compares schema checksums and every table's
row count, verifies RLS policies and effective tenant isolation, proves foreign
keys, then boots the app and authenticates against the restored copy.

A Railway staging `pg_dump`/`pg_restore` drill also restored all 32 migrations
and its seeded tenant into `convo_restore_drill_20260917`; dump took under one
second and restore took two seconds. The disposable database was removed.

On 2026-09-17 Railway's native backup restore workflow successfully booted the
named production recovery point. Important platform behavior discovered during
the drill: `railway postgres pitr backup restore` swaps the selected service's
volume; it does **not** provision an isolated service. The original volume was
preserved, reattached, and production returned healthy (`/healthz` 200) with
its original 25-migration schema. The restored snapshot remains detached for
forensic use. This proves the native recovery point is bootable, but it is not
an isolated application/readback drill and must never be invoked casually on a
live service.

## Safe restore procedure

1. Stop application writers and record current deployment/volume identifiers.
2. Create a scratch Railway environment and a scratch Postgres service first.
3. Copy/restore the recovery point into that scratch target. Do not run the PITR
   restore command with the live Postgres service selected: the CLI swaps its
   mounted volume.
4. Apply the candidate migrations to the scratch database.
5. Verify migration names/checksums, row counts, forced RLS and foreign keys.
6. Boot a scratch API against it; authenticate and read contacts,
   conversations, campaigns and automation state.
7. Record elapsed time. That is the measured RTO.
8. Delete only the scratch resources after the evidence is retained.

## Verification SQL

```sql
SELECT name, checksum FROM schema_migrations ORDER BY name;

SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;

BEGIN;
SELECT set_config('convo.tenant_id', '<real tenant id>', true);
SELECT count(*) FROM contacts;
SELECT set_config('convo.tenant_id', '00000000-0000-4000-8000-0000000000ff', true);
SELECT count(*) FROM contacts;
ROLLBACK;
```

## Production recovery

Restore into a new database/volume, never overwrite the only remaining copy.
Run migrations, repoint the services, start API first and then workers. Review
`outcome_unknown` outbound messages manually; they may have reached a provider
and must not be retried automatically. Inspect pending email and inbound
provider retry gaps at the recovery seam.

## Remaining risk

- A fully isolated native Railway snapshot restore with application readback is
  still required before asserting a measured platform RTO.
- Backups remain inside one provider/account; independent retention is not
  configured.
- Recovery access is held by one operator.
