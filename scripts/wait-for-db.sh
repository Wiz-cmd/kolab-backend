#!/bin/sh
# Wait for the database to become reachable, then apply migrations.
# Survives the race where the web service boots before a free Postgres is ready.
set -e

TRIES="${DB_WAIT_TRIES:-60}" # 60 * 10s = up to 10 minutes of waiting
for i in $(seq 1 "$TRIES"); do
  if npx prisma migrate deploy; then
    echo "[wait-for-db] database reachable; migrations applied"
    exit 0
  fi
  echo "[wait-for-db] database not ready yet (attempt $i/$TRIES), retrying in 10s..."
  sleep 10
done

echo "[wait-for-db] could not reach the database after $TRIES attempts" >&2
exit 1