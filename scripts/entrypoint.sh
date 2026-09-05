#!/bin/sh
# Container entrypoint: wait for DB, migrate, seed, then boot the API.
set -e

sh scripts/wait-for-db.sh
node dist/prisma/seed.js
exec node dist/src/main.js