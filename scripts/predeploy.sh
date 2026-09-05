#!/bin/sh
# Render preDeployCommand: wait for DB, apply migrations, seed.
# Runs before the service is live so the health check never races the schema.
set -e

sh scripts/wait-for-db.sh
node dist/prisma/seed.js
echo "[predeploy] migrations applied and seed complete"