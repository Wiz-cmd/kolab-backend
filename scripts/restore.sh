#!/usr/bin/env bash
# Restore a Kolab backup into the DB. DANGER: overwrites existing data.
# Usage: BACKUP_FILE=./backups/kolab_20260101_000000.sql.gz DATABASE_URL="postgresql://..." ./scripts/restore.sh
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL is required}"
FILE="${BACKUP_FILE:?BACKUP_FILE is required}"

if [ ! -f "$FILE" ]; then
  echo "Backup file not found: $FILE" >&2
  exit 1
fi

echo "Restoring $FILE into $DB_URL ..."
gunzip -c "$FILE" | psql "$DB_URL"
echo "Restore complete."
