#!/bin/sh
set -eu

PROJECT_ID='09c4e61b-b956-466f-bb21-9b32fc4527f5'
STAGING_ID='6c7d3ce1-db61-40fd-9cf7-bffac954eda5'
PRODUCTION_ID='ea473c79-c29e-4aab-91c4-e48f606dc057'
# Deployment is intentionally pinned to the latest reviewed schema. Update this
# guard together with the PR that introduces the next forward migration.
EXPECTED_MIGRATION='0043_conversation_removal.sql'

usage() {
  echo 'usage: deploy-railway.sh <staging|production> <full-sha> <service> [--confirm-production]' >&2
  exit 64
}

[ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage

target=$1
release_sha=$2
service=$3
confirmation=${4:-}
git_bin=${GIT_BIN:-git}
railway_bin=${RAILWAY_BIN:-railway}

case "$target" in
  staging) environment_id=$STAGING_ID ;;
  production)
    environment_id=$PRODUCTION_ID
    [ "$confirmation" = '--confirm-production' ] || {
      echo 'production requires the explicit --confirm-production argument' >&2
      exit 64
    }
    ;;
  *) usage ;;
esac

case "$service" in
  convo-database|convo-api|convo-client-demo|convo-worker-inbound|convo-worker-interactive|convo-worker-campaign|convo-worker-report|convo-worker-integration|convo-worker-automation) ;;
  *)
    echo "unsupported service: $service" >&2
    exit 64
    ;;
esac

case "$release_sha" in
  *[!0-9a-f]*|'')
    echo 'release SHA must be 40 lowercase hexadecimal characters' >&2
    exit 64
    ;;
esac
[ "${#release_sha}" -eq 40 ] || {
  echo 'release SHA must be 40 lowercase hexadecimal characters' >&2
  exit 64
}

command -v "$git_bin" >/dev/null 2>&1 || { echo 'git is required' >&2; exit 69; }
command -v "$railway_bin" >/dev/null 2>&1 || { echo 'railway CLI is required' >&2; exit 69; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required' >&2; exit 69; }

repo_root=$($git_bin rev-parse --show-toplevel)
cd "$repo_root"

[ -z "$($git_bin status --porcelain)" ] || {
  echo 'refusing to deploy from a dirty worktree' >&2
  exit 65
}

$git_bin fetch --quiet origin --tags '+refs/heads/*:refs/remotes/origin/*'
$git_bin cat-file -e "${release_sha}^{commit}" 2>/dev/null || {
  echo 'release SHA is not available after fetching origin' >&2
  exit 65
}

remote_branches=$($git_bin branch -r --contains "$release_sha" | sed -n '/^[[:space:]]*origin\//p')
remote_tags=$($git_bin ls-remote origin 'refs/tags/*' | awk -v sha="$release_sha" '$1 == sha { print $2 }')
[ -n "$remote_branches$remote_tags" ] || {
  echo 'release SHA is not reachable from a fetched remote branch or tag' >&2
  exit 65
}

if [ "$target" = 'production' ]; then
  exact_tag=$($git_bin tag --points-at "$release_sha" | sed -n '/^v[0-9]/p' | head -n 1)
  [ -n "$exact_tag" ] || {
    echo 'production requires an immutable version tag pointing exactly at the SHA' >&2
    exit 65
  }
  remote_tag_targets=$($git_bin ls-remote origin "refs/tags/$exact_tag" "refs/tags/$exact_tag^{}" |
    awk '{ print $1 }')
  printf '%s\n' "$remote_tag_targets" | grep -qx "$release_sha" || {
    echo "production version tag $exact_tag is not published at the requested SHA" >&2
    exit 65
  }
fi

latest_migration=$($git_bin ls-tree -r --name-only "$release_sha" packages/database/migrations | sed -n 's#packages/database/migrations/##p' | sort | tail -n 1)
[ "$latest_migration" = "$EXPECTED_MIGRATION" ] || {
  echo "unexpected migration high-water mark: $latest_migration" >&2
  exit 65
}

source_repo=$($railway_bin status -p "$PROJECT_ID" -e "$environment_id" --json |
  jq -r --arg service "$service" '.environments.edges[0].node.serviceInstances.edges[].node | select(.serviceName == $service) | (.source.repo // "")')
[ -z "$source_repo" ] || {
  echo "refusing deployment while $service still has a GitHub source trigger" >&2
  exit 65
}

release_tree=$(mktemp -d "${TMPDIR:-/tmp}/convo-railway-release.XXXXXX")
cleanup() {
  $git_bin -C "$repo_root" worktree remove --force "$release_tree" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM

$git_bin worktree add --quiet --detach "$release_tree" "$release_sha"

echo "deploying service=$service environment=$target environment_id=$environment_id sha=$release_sha"
"$railway_bin" variable set "CONVO_RELEASE_SHA=$release_sha" --skip-deploys \
  --project "$PROJECT_ID" --environment "$environment_id" --service "$service" >/dev/null
"$railway_bin" up "$release_tree" --path-as-root --project "$PROJECT_ID" \
  --environment "$environment_id" --service "$service" --ci \
  --message "immutable ${target} ${release_sha}"
