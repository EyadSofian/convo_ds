#!/usr/bin/env bash
# Root-owned forced command. The CI key cannot open a shell or forward ports.
set -euo pipefail
umask 077

root=${CONVO_DEPLOY_ROOT:-/opt/convo}
compose_file="$root/deploy/docker-compose.hostinger.yml"
state="$root/.deploy"
compose() {
  docker compose --env-file "$root/.env" -f "$compose_file" "$@"
}
preflight() {
  test -f "$root/.env"
  test -f "$root/.env.runtime"
  test -x "$root/deploy/backup.sh"
  compose config -q
  docker info > /dev/null
}

if [[ ${SSH_ORIGINAL_COMMAND:-} == check ]]; then
  preflight
  echo 'Deployment preflight passed; no services changed.'
  exit 0
fi
if [[ ! ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([0-9a-f]{40})\ ([0-9a-f]{64})$ ]]; then
  echo 'Only check or deploy <commit-sha> <archive-sha256> is permitted.' >&2
  exit 64
fi
sha=${BASH_REMATCH[1]}
checksum=${BASH_REMATCH[2]}
export CONVO_IMAGE="convo:$sha"
mkdir -p "$state"
exec 9> "$state/lock"
flock -n 9 || { echo 'Another deployment is running.' >&2; exit 75; }
preflight
archive=$(mktemp "$state/image.XXXXXX.tar.gz")
phase=receive
cleanup() {
  result=$?
  rm -f "$archive"
  if (( result != 0 )); then
    printf 'FAILED sha=%s phase=%s\n' "$sha" "$phase" > "$state/last-attempt"
    echo "Deployment failed during $phase. No database rollback was attempted." >&2
    echo 'Inspect /opt/convo/.deploy and follow the Hostinger recovery runbook.' >&2
  fi
}
trap cleanup EXIT
# Bound an interrupted/stalled upload and reject oversized input before Docker.
timeout 900 head -c 2147483649 > "$archive"
[[ $(stat -c %s "$archive") -le 2147483648 ]]
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
phase=load
docker load -i "$archive"
revision=$(docker image inspect "$CONVO_IMAGE" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
[[ $revision == "$sha" ]]
previous=$(docker inspect convo-api-1 --format '{{.Image}}')
printf '%s\n' "$previous" > "$state/previous-image"
phase=backup
"$root/deploy/backup.sh"
phase=migrate-and-start
printf 'IN_PROGRESS sha=%s phase=%s\n' "$sha" "$phase" > "$state/last-attempt"
# Stop writers so migrations do not race the previous version. This is a
# maintenance-window deployment, not a zero-downtime rollout.
compose stop web api worker-inbound worker-interactive worker-campaign worker-report worker-automation worker-integration
compose up -d --no-build --pull never --wait --wait-timeout 180
phase=smoke
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 3 --max-time 15 http://127.0.0.1:8080/healthz > /dev/null
curl --fail --silent --show-error --retry 5 --retry-delay 3 --max-time 15 https://omnichannel.berlitzdigitalschool-eg.com/healthz > /dev/null
curl --fail --silent --show-error --max-time 15 https://omnichannel.berlitzdigitalschool-eg.com/api/v1/instance > /dev/null
printf 'CONVO_IMAGE=%s\n' "$CONVO_IMAGE" > "$root/.release.env.tmp"
mv "$root/.release.env.tmp" "$root/.release.env"
printf '%s\n' "$sha" > "$state/current-sha"
printf 'SUCCESS sha=%s\n' "$sha" > "$state/last-attempt"
echo "Deployed $sha; all Compose health checks and public smoke checks passed."
