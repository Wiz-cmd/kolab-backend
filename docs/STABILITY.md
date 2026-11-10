# Kolab — Stability, Free Services & Recovery Guide

Last updated: 2026-11-10

This document records the stability audit of the Kolab API + Android app, the
free services chosen to keep it running, and the exact recovery steps after the
October 2026 outage.

---

## 1. What was wrong (root causes)

| # | Problem | Impact |
|---|---------|--------|
| 1 | Render free Postgres expired on **2026-10-05** (`expiresAt` in Render's API) | API cannot reach the DB; every request fails |
| 2 | Last Render deploy ended `nonZeroExit 1` (2026-09-05) | Service has been down/unhealthy since |
| 3 | Local `main` was **3 commits ahead** of `origin/main` | The deploy fixes were never shipped |
| 4 | `keep-alive.yml` was **untracked** | Render free service kept sleeping (slow cold starts) |
| 5 | `render.yaml` had `APP_BASE_URL=https://kolab-api.onrender.com` | Wrong host in PayFast return URLs / reset links |
| 6 | Production used `CORS_ORIGINS=*` and `SWAGGER_ENABLED=true` | Unnecessary public attack surface |
| 7 | `/api/health` returned HTTP 200 even when the DB was down | Platform marked broken instances as healthy |
| 8 | Android app **did not compile** (`RectangleShape` unresolved) | No APK could be built |
| 9 | Render DB credentials + JWT secret sat in plaintext scratch JSON | Secret exposure |

No production data may be recoverable if Render already deleted the expired DB.
The seed script (`prisma/seed.ts`) is idempotent and can rebuild provinces,
hotspots and demo users.

---

## 2. What changed in this repo

- `src/ai/*` — free **GitHub Models** AI module (`/api/ai/status`,
  `/api/ai/caption`, `/api/ai/bio`). Fully env-gated; returns 503 when unset.
- `src/app.controller.ts` — `/api/health` now returns **503** when the DB is
  down; added `/api/health/live` (DB-free liveness).
- `render.yaml` — correct `APP_BASE_URL`, CORS locked to the API origin,
  Swagger off, Render database removed (use Neon), secrets marked `sync:false`.
- `.github/dependabot.yml` — weekly grouped dependency + Actions + Docker
  updates (free).
- `.github/workflows/keep-alive.yml` — pings the API every 10 minutes so the
  free Render instance (and Neon) stay warm.
- `.gitignore` — ignores local secret dumps (`out_*.json`, `login.json`, …).
- `scripts/set-github-secrets.ps1` — stores keys in free GitHub Actions
  encrypted secrets.
- Android: fixed compile error, single-flight token refresh (prevents random
  logouts), redacted auth headers from debug logs, added Sentry crash reporting.

---

## 3. Recover production (Neon free Postgres)

Neon's free tier does **not** expire (0.5 GB storage, generous compute hours).
It is the recommended replacement for Render's 30-day free Postgres.

1. Create a free account at <https://neon.tech>.
2. Create a project (region: **AWS us-east-2 / Ohio** to match Render).
3. Copy the **pooled** connection string. It looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. In the Render dashboard → `kolab-api` → **Environment**, set:
   - `DATABASE_URL` = the Neon connection string
   - `JWT_SECRET` = a fresh random value (`openssl rand -hex 64`)
   - `GITHUB_MODELS_TOKEN` = your free GitHub Models token (see §4)
   - `CORS_ORIGINS` = `https://kolab-api-7r6i.onrender.com` (add real web
     origins if you add a web client)
   - `SWAGGER_ENABLED` = `false`
5. Confirm `APP_BASE_URL` = `https://kolab-api-7r6i.onrender.com`.
6. Redeploy. The container entrypoint waits for the DB, runs
   `prisma migrate deploy`, seeds, then boots the API.
7. Verify:
   ```bash
   curl -fsS https://kolab-api-7r6i.onrender.com/api/health
   # {"status":"ok","db":"up",...}
   ```

> **Note:** if the old Render database still exists and you need its data, take
> a `pg_dump` *before* deleting it, then `psql "$NEON_URL" < dump.sql`.

### Verify locally against Neon

```bash
# .env
DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"
npx prisma migrate deploy
npm run seed
npm run start:dev
```

---

## 4. Free AI keys with GitHub Models

GitHub Models gives free, rate-limited inference to GitHub accounts. No credit
card required.

1. Go to <https://github.com/settings/tokens> → **Fine-grained tokens** →
   **Generate new token**.
2. Repository access: *Public repositories (read-only)* is enough.
3. Permissions → Account permissions → **Models: Read-only**.
4. Copy the token (starts with `github_pat_...`).
5. Put it in the backend environment (never commit it):
   ```
   GITHUB_MODELS_TOKEN="github_pat_..."
   AI_BASE_URL="https://models.github.ai/inference"
   AI_MODEL="openai/gpt-4o-mini"
   ```
6. Check: `GET /api/ai/status` → `{"configured":true,...}`.

The client is OpenAI-compatible, so you can switch to another free provider
(e.g. Groq, OpenRouter free models, or a local Ollama) by changing
`AI_BASE_URL` and `AI_MODEL` — no code changes.

### Store keys in GitHub Actions secrets (free)

```powershell
$env:GITHUB_TOKEN = "github_pat_..."   # needs Secrets: write
./scripts/set-github-secrets.ps1 `
  -Repo Wiz-cmd/kolab-backend `
  -EnvFile .env `
  -Keys DATABASE_URL,JWT_SECRET,GITHUB_MODELS_TOKEN,SENTRY_DSN
```

Secrets are encrypted with the repository public key before upload and are not
readable back out — even by repo admins.

---

## 5. Recommended open-source repos to adopt next

These are mature, free projects that address the remaining stability gaps.

### Android

| Repo | Why |
|------|-----|
| <https://github.com/android/nowinandroid> | Google's official Compose architecture sample: offline-first, modularization, testability, error handling. Best reference for long-term stability. |
| <https://github.com/getsentry/sentry-java> | **Already added.** Free crash/ANR reporting. |
| <https://github.com/androidx/androidx> (Paging 3) | Replace hand-rolled feed pagination; handles retries, dedupe and placeholders. |
| <https://github.com/google/secrets-gradle-plugin> | **Already used.** Keeps API keys out of source. |
| <https://github.com/firebase/quickstart-android> | Reference wiring for FCM + Crashlytics if you add `google-services.json`. |
| <https://github.com/robolectric/robolectric> | **Already used.** JVM UI tests without an emulator. |

### Backend

| Repo | Why |
|------|-----|
| <https://github.com/nestjs/terminus> | Standard health/readiness probes (replaces the custom health handler over time). |
| <https://github.com/taskforcesh/bullmq> | Durable job queue with retries/backoff — the current in-process queue loses jobs on restart. |
| <https://github.com/nestjs/throttler> | Well-tested rate limiting (the current middleware is in-memory and per-instance). |
| <https://github.com/getsentry/sentry-javascript> | **Already optional** via `SENTRY_DSN`. |
| <https://github.com/notiz-dev/nestjs-prisma-starter> | Reference for NestJS + Prisma + Docker + Swagger patterns. |
| <https://github.com/AlbertHernandez/nestjs-service-template> | Production checklist: config validation, testing, observability. |
| <https://github.com/public-apis/public-apis> | Curated free APIs (no key or free tier) for future features. |

### Free services worth using

- **Neon** — permanent free Postgres (<https://neon.tech>)
- **Sentry** — free crash reporting (<https://sentry.io>)
- **GitHub Models** — free AI inference (<https://models.github.ai>)
- **Cloudflare R2** — 10 GB free object storage for uploads (replaces `/tmp`,
  which is wiped on every Render restart)
- **UptimeRobot** — free uptime monitoring on `/api/health/live`

---

## 6. Security cleanup checklist (do these once)

- [ ] **Rotate the GitHub token** currently embedded in
      `kolab-backend-updated/.git/config`. Revoke it at
      <https://github.com/settings/tokens> and re-authenticate with Git
      Credential Manager.
- [ ] **Rotate the Render Postgres password** (the old URL is in local JSON
      files). The old DB is expired, but rotate anything reused.
- [ ] **Rotate `JWT_SECRET`** in Render (all sessions are invalidated).
- [ ] Delete local scratch files that contain secrets:
      `out_env.json`, `out_postgres.json`, `out_events.json`, `login.json`,
      `reg.json`, `reg2.json`, `appbase*.json`.
- [ ] Keep `.env` out of git (already ignored) and never paste production
      values into issues/PRs.
- [ ] Add `ENABLE_HSTS=true` once TLS is confirmed in front of the API.
- [ ] Consider moving uploads to Cloudflare R2; Render's `/tmp` is ephemeral.

---

## 7. CI behaviour

- `kolab-backend/.github/workflows/ci.yml` runs install → Prisma generate →
  typecheck → build → 63+ unit tests → migrations → API smoke test on every
  push/PR.
- `kolab/.github/workflows/build-apk.yml` builds a debug APK in the cloud and
  runs JVM tests.
- Both repos now have Dependabot for weekly, grouped updates.
