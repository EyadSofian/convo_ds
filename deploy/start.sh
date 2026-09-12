#!/bin/sh
set -eu

if [ "${CONVO_SERVICE_KIND:-api}" = "web" ]; then
  exec node apps/web/server.mjs
fi

if [ "${CONVO_SERVICE_KIND:-api}" = "database" ]; then
  node packages/database/dist/bin.js bootstrap
  exec node packages/database/dist/bin.js migrate
fi

exec node apps/api/dist/main.js
