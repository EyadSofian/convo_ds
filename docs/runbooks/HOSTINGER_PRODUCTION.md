# Hostinger production deployment

Target: `185.77.96.36`, Ubuntu 24.04, Docker Compose project `convo` in
`/opt/convo`. Public origin: https://omnichannel.berlitzdigitalschool-eg.com.
Caddy and PostgreSQL data volumes remain on the VPS. This runbook is separate
from the Railway environments and their recovery evidence.

## Pipeline

`main` push → existing **CI** succeeds → **Deploy Hostinger** builds the exact
tested SHA on a GitHub runner → gzip-compressed Docker image crosses pinned
SSH → server verifies checksum and image revision → database backup → stop app
writers → migrations and service startup → readiness and public HTTPS checks.
PR/fork runs, failed CI and superseded main commits cannot deploy. Re-run the
successful main CI run to retry a failed deployment; there is no ungated manual
deployment workflow. GitHub and server locks serialize deployments.

The existing CI suite includes lint, type checks, build, unit/integration,
property, contract, security and coverage checks. The new receiver tests cover
command injection, checksum/image mismatch, backup failure and startup/smoke
failure without using production. Release-validation remains a separate manual
workflow; this pipeline does not claim it ran load, visual or recovery tests.

## One-time activation

1. Install `deploy/docker-compose.hostinger.yml` in `/opt/convo/deploy/` and
   `deploy/hostinger-receive.sh` as root-owned mode 700 at
   `/usr/local/sbin/convo-ci-receive`. Keep the existing root-only `.env`,
   `.env.runtime` and executable `deploy/backup.sh`. The receiver only deploys
   images; changing the server Compose definition or receiver requires an
   operator to review/install those files separately.
2. Generate a dedicated Ed25519 CI key outside this repository. Add its public
   key to root's `authorized_keys` with this exact prefix:
   `restrict,command="/usr/local/sbin/convo-ci-receive"`.
   It permits only `check` and `deploy <40-hex-sha> <64-hex-checksum>`, without
   interactive shell, forwarding or SCP. A deployment key can execute trusted
   application images and therefore remains a privileged production secret.
3. Add Actions secrets `HOSTINGER_DEPLOY_KEY` (private CI key) and
   `HOSTINGER_KNOWN_HOSTS` (verified host-key line from a trusted existing SSH
   connection). Do not use runtime `ssh-keyscan` or disable host-key checking.
   Use repository secrets or the `hostinger-production` environment. Configure
   that environment's required reviewers if each rollout needs human approval.
4. Run `ssh -i <ci-key> root@185.77.96.36 check`. It must pass without changing
   services. Installations must have Docker Compose supporting `--wait`.
5. Publish these changes to `main` through normal review. `workflow_run`
   workflows must exist on the default branch. Check both the CI result and
   the subsequent Deploy Hostinger result; a successful build alone is not a
   successful deployment.

No registry account or database/provider credentials are needed in GitHub.
Secrets stay on the server and are excluded from the Docker build context.
The web service receives no database secrets, runtime services receive runtime
credentials, and only the one-shot database service receives migration/admin
credentials. The public web port binds only to loopback behind Caddy.

## Operation and recovery

Deployments have a short maintenance window. The receiver stops app writers
before running migrations. `up --wait` checks database/API/web health and worker
readiness. It also checks public HTTPS after startup. No images or volumes are
automatically pruned. Monitor disk use and remove reviewed obsolete images
while retaining the current and previous images.

Inspect `/opt/convo/.deploy/last-attempt`, `current-sha` and `previous-image`.
The last successful image is recorded in `/opt/convo/.release.env`; it is only
updated after successful health checks. A failed attempt can have already
changed the schema or started candidate containers. Do not assume the release
record describes those containers after failure. Use `docker compose ps -a`
and inspect their image IDs.

An operator can inspect production without printing secrets:

```sh
cd /opt/convo
docker compose --env-file .env --env-file .release.env \
  -f deploy/docker-compose.hostinger.yml ps -a
cat .deploy/last-attempt
```

Before the first pipeline rollout `.release.env` may not exist; omit that
second `--env-file` for inspection only.

If failure occurs before stopping writers, the previous deployment remains
running. If migrations/startup fail, inspect the migration result and application
health, then deploy a forward fix. There is deliberately no automatic database
restore or unconditional application rollback: an earlier app may not support
the newly migrated schema. Only after verifying backward compatibility, an
operator may select the image ID recorded in `.deploy/previous-image` through
`CONVO_IMAGE` and start the app services with `--no-deps` to avoid rerunning old
migrations. Record the recovery and update `.release.env` only once healthy.

The pre-deployment backup uses the existing script in `/opt/convo/deploy` and
retains daily local dumps in `/var/backups/convo`. These are local backups, not
off-server disaster recovery or proof of a successful restore drill. Arrange
independent backups and test restores before relying on this for critical data.
