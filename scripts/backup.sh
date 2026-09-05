#!/usr/bin/env bash
# Daily PostgreSQL backup for Kolab.
# Usage: BACKUP_DIR=./backups DATABASE_URL="postgresql://..." ./scripts/backup.sh
set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="${BACKUP_DIR}/kolab_${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# pg_dump supports postgres:// URLs directly.
pg_dump --no-owner --no-privileges "$DB_URL" | gzip > "$FILE"

echo "Backup written: $FILE ($(du -h "$FILE" | cut -f1))"

# Prune backups older than KEEP_DAYS.
find "$BACKUP_DIR" -name 'kolab_*.sql.gz' -mtime "+${KEEP_DAYS}" -delete

echo "Retention: keeping ${KEEP_DAYS} days."
