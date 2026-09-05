# Kolab Ops Runbook

Operational notes for the Kolab backend: backups, rollback, and common incidents.

## Backups

- `./scripts/backup.sh` dumps the database with `pg_dump` and gzips it into
  `./backups/` (default retention 14 days).
- `./scripts/restore.sh` restores a `.sql.gz` backup. **It overwrites data.**
- Recommended cron (daily 03:00 SAST):
  ```
  0 3 * * *  cd /opt/kolab && BACKUP_DIR=/var/backups/kolab DATABASE_URL="$DATABASE_URL" ./scripts/backup.sh
  ```
- For S3 offsite copy, add an `aws s3 cp` / `rclone copy` line to `backup.sh`.

## Migrations / Rollback

Prisma migrations are committed under `prisma/migrations/`:

| Migration | Purpose |
|-----------|---------|
| `20260827000000_init` | Baseline schema (all core tables, enums, indexes). |
| `20260827100000_add_products_features` | Verification, saved searches, rate cards, collections, analytics, moderation, 2FA fields, contracts/push additions. |

- Apply: `npx prisma migrate deploy` (safe, non-interactive, used in CI/Docker).
- Develop: `npx prisma migrate dev` (regenerates client + baselines).
- **Rollback a migration** (only the last one, safely):
  1. `npx prisma migrate resolve --rolled-back <migration_name>` marks it as not applied.
  2. Manually run the `DROP TABLE ...` / `ALTER TABLE ...` statements in reverse
     (Prisma does not generate down-migrations). Keep a backup before rolling back.
- Never hand-edit an applied migration — create a new one instead.

### Deployment rollback
- Re-deploy a previous image/tag. Since `migrate deploy` only runs forward,
  a DB schema rollback must be done manually per the steps above and you must
  ensure the app version is compatible with the repaired schema.

## Verified-badge / moderation
- `GET /api/verification/me` — a creator's badge status.
- `POST /api/verification` — submit ID + portfolio proof.
- `POST /api/admin/verification/:id/approve` / `.../reject` — admin review.
- `POST /api/admin/moderation/:id/approve` / `.../remove` — content queue.
- Auto-flagging runs on post create; score ≥ 0.15 is queued for review.

## 2FA
- `POST /api/auth/2fa/setup` → returns secret + otpauth URL.
- `POST /api/auth/2fa/enable` `{secret, code}` → enables.
- `POST /api/auth/2fa/disable` `{code}` → disables.
- Login with `twoFactorCode` when the account has 2FA enabled.

## Payouts
- `PAYOUT_DRIVER=mock` (default) simulates provider payouts.
- `PAYOUT_DRIVER=ozow` / `payfast` make real API calls; set credentials + endpoint.
- A provider rejection auto-fails the withdrawal and refunds the reserved funds.

## Incident checklist
1. Check `GET /api/health` (DB connectivity) and `GET /api/metrics` (memory/uptime).
2. Review structured JSON logs (`LOG_STRUCTURED=true`) tagged by request ID.
3. If `SENTRY_DSN` is set, triage the latest events.
4. Confirm the last applied migration matches the deployed release
   (`npx prisma migrate status`).
5. Restore a backup only after confirming the failure is data-related.
