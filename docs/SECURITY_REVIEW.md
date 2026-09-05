# Kolab Security Review

Findings and remediations for the Kolab creator platform backend (NestJS + Prisma).

Status: **fixes applied, reviewed, typecheck + tests + build green**
(63/63 unit tests + 6/6 live security e2e against a real Postgres).

## Verification commands

```bash
npm run typecheck              # tsc --noEmit — clean
npm test                       # jest — 63 tests passing
npm run build                  # nest build — clean
# live security suite (needs a booted server):
$env:E2E_BASE_URL='http://localhost:3000'; npx jest --testRegex '.*(e2e-)?spec\.ts$' --testPathPattern 'security'
```

> Install note: `npm ci` fails because no `package-lock.json` was committed for the
> pinned dependency set, and `@nestjs/schedule@4.1.2` only peers NestJS ≤ 10 while the
> project uses NestJS 11. Use:
> `npm install --legacy-peer-deps` (a lockfile is now generated) and commit it so CI can
> use `npm ci`.

## Findings & remediation

### CRITICAL — Admin self-registration via `role` parameter
- **Where:** `src/auth/auth.service.ts` (`register`), `src/auth/auth.controller.ts` (`RegisterDto`).
- **Issue:** `POST /api/auth/register` accepted an attacker-chosen `role` and wrote it
  straight to the user row. Registering with `role: "ADMIN"` minted an admin — full
  takeover (release escrow, refund deals, moderation, user management).
- **Fix (defense in depth):**
  1. `RegisterDto.role` is now constrained by `@IsIn(PUBLIC_SIGNUP_ROLES)` where
     `PUBLIC_SIGNUP_ROLES = [CREATOR, MODEL, PHOTOGRAPHER, BRAND]` — `ADMIN` rejected at
     the validation layer.
  2. `register()` in the service additionally forces `role === ADMIN → CREATOR` so a
     bypass at the DTO layer still cannot self-assign admin.
- **Regression test:** `src/auth/auth.service.spec.ts` (“never mints an ADMIN account…”).

### CRITICAL — Public user objects leaked highly sensitive fields
- **Where:** `src/users/users.service.ts` (`findById`), `src/users/users.controller.ts`.
- **Issue:** `GET /users/:id` returned the full Prisma `user` row to unauthenticated
  callers, including `passwordHash` and `twoFactorSecret`. Anyone could harvest password
  hashes for offline cracking and steal TOTP secrets to break into 2FA accounts (brands/admin).
- **Fix:**
  - New `publicSelect` allow-list (id, name, role, avatar/cover URLs, bio, location, rate,
    verification badge, counts, timestamps) is the only thing non-owners see.
  - `findById` uses strict `select`.
  - New owner `findMe` explicitly strips `passwordHash` and `twoFactorSecret` (also strips
    any other secret fields that may be added later) and is used by `GET /users/me`.

### HIGH — Weak, hard-coded fallback JWT secret in production
- **Where:** `src/auth/jwt.strategy.ts`, `src/chat/chat.gateway.ts`, `src/auth/auth.module.ts`,
  `src/chat/chat.module.ts`.
- **Issue:** All four paths fell back to `kolab-dev-secret-change-me` when `JWT_SECRET` was
  unset. Anyone who knew the (public) default could forge tokens for any user, including ADMIN.
- **Fix:** New shared helper `src/auth/jwt-secret.ts`:
  - Production (`NODE_ENV=production`): **throws** unless `JWT_SECRET` is set, ≥ 32 chars,
    and not the dev default.
  - Dev hygiene: still refuses the known default silently.
  - Used by the JWT strategy, `JwtModule.register` (auth + chat), and the chat gateway’s
    `handleConnection` verification.

### MEDIUM — Password-reset endpoint doubles as an account enumerator
- **Where:** `src/auth/auth.service.ts` (`requestPasswordReset`).
- **Issue:** Responses (and timing) differed for existing vs. unknown emails.
- **Fix:** Response shape normalized for both cases (no per-case body/field differences);
  reset codes still emailed only to real users.

### MEDIUM — Login lockout could be weaponised as a DoS
- **Where:** `src/auth/auth.service.ts` (`login`).
- **Issue:** With the OLD `MAX_FAILED_LOGINS = 5`, one person could lock an arbitrary victim
  out of their account with 5 wrong passwords. Lockout also never cleared attempt counters on
  expiry of the lock window.
- **Fix:** `MAX_FAILED_LOGINS = 10`; on lockout expiry the counter and `lockedUntil` are reset
  so the account recovers automatically and the attacker cannot keep it locked forever.

### MEDIUM — Uploads trusted declared MIME type / client filename
- **Where:** `src/storage/storage.service.ts`, `src/uploads/uploads.controller.ts`.
- **Issue:** Servers stored files using a client-supplied filename and extension and trusted
  the HTTP `Content-Type`. An attacker could upload an HTML/JS payload as `image/gif` and have
  it served at a guessable/derivable URL → stored XSS. PNG content could be mislabeled, etc.
- **Fix:**
  - `validateFile()` sniffs magic bytes (JPEG/PNG/GIF/WebP/MP4/MOV/AVI/MKV) and verifies they
    match the declared `Content-Type`; mismatches and unknown blobs are rejected.
  - File extension is now derived server-side from the *validated* content type
    (`buildKey(contentType)`); the client filename is never used.
  - GIF is now re-encoded via sharp (was skipped) so GIF content is also a real image buffer.
  - Per-user daily upload quota (default 100 MB/day) with a bounded in-memory map.

### LOW — Swagger UI exposed by default
- **Where:** `src/main.ts`.
- **Issue:** `/api/docs` (Swagger) shipped on by default — a public inventory of every
  endpoint, DTO, and auth scheme.
- **Fix:** Swagger is only mounted when `SWAGGER_ENABLED === 'true'` (default off in production).

### LOW — Proxy-less IP handling
- **Where:** `src/main.ts`.
- **Issue:** Behind a reverse proxy, every client shared the proxy IP, breaking per-IP rate
  limiting, audit logging, and IP-based abuse response.
- **Fix:** `app.set('trust proxy', ...)` is set from `TRUST_PROXY` (hop count, default 0).

## Also fixed along the way (pre-existing, found during verification)

- `src/moderation/moderation.service.ts` used `this.prisma` without injection — every
  moderation call (`reviewNewPost`, `listQueue`, `review`) would have thrown at runtime.
  Constructor injection added (PrismaModule is `@Global()`).
- `src/auth/auth.controller.ts` `LoginDto` had no `twoFactorCode` field while `login()`
  read it — 2FA logins could never succeed. Field added (`@IsOptional @IsString`).
- `package.json` was missing `@nestjs/testing` (imported by every spec) and
  `jest.config.js` was missing `module.exports` — the test suite could never run.
- Status-guard array `.includes()` typing errors in contracts/deals/withdrawals services.
- `src/verification/verification.service.ts` invalid `as const` assertion.

## Round 2 — security hardening + performance (verified live)

Applied and verified against a live PostgreSQL 16 + booted app, with a
300-post dataset and `autocannon`.

### Security fixes

- **Request-path logs leaked query strings** — `RequestContextMiddleware` logged
  `req.originalUrl`; reset/verification tokens in query strings would land in logs.
  Now logs the query-stripped path (also fixed `req.path` being unreliable under
  the global prefix — requests were logging as `POST /`).
- **Oversized bodies returned 500** — body-parser `413/415` errors were collapsed to
  `Internal server error` by the global filter. The filter now passes raw 4xx
  parser errors through as proper `413`/`415` responses.
- **`X-Powered-By: Express` leaked** — removed (`app.disable('x-powered-by')`) to
  stop passive framework fingerprinting.
- **HSTS/Permissions-Policy gaps** — `SecurityHeadersMiddleware` now emits
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()` plus
  `Strict-Transport-Security` when `ENABLE_HSTS=true` (never on plain HTTP).
- **`AppLogger` could not boot via DI** — defaulted primitive params (`context`,
  `toJson`) made Nest try to resolve `String`/`Boolean` providers. Now `@Optional()`
  (latent — app had never been booted before this round).
- **Chat gateway** — CORS switched from `origin: true` (reflect-any) to configured
  `CORS_ORIGINS`; socket hardened with `maxHttpBufferSize: 1e6`, `pingInterval/Timeout`.
- **HTTP server hardening** — `requestTimeout`/`headersTimeout`/`keepAliveTimeout` +
  `setTimeout` for slowloris/hang protection; JSON/urlencoded bodies capped at 1 MB.
- **`app.enableCors`** — `*` now implies `credentials: false` (never reflect *every*
  origin while allowing credentialed requests).
- **Dependency audit** — runtime-critical highs fixed: `nodemailer` 6 → 9 (SMTP
  injection CVEs), `sharp` 0.33 → 0.35 (libvips CVEs). Remaining advisories are
  Prisma-CLI-toolchain-only (dev-time, no runtime surface) pending Prisma 7.

### Performance (measured on this machine, 10 concurrent connections)

| Endpoint | Before (pattern) | After | RPS | Avg latency |
|----------|------------------|-------|-----|-------------|
| `GET /api/posts/feed` | ~31 queries/request (1 + N `_count.likes`) | 2 cold / 0 cached | **270** | 36 ms |
| `GET /api/hotspots` | uncached query per request | 30 s cache | **386** | 25 ms |
| `GET /api/health` | baseline | — | **244** | 40 ms |

Changes:
- Posts feed: dropped `include: { _count: { likes: true } }` (1+N COUNTs); uses the
  maintained `likesCount` column. Cold feed caches 10 s, for-you candidate pool
  10 s, public cold-start feed 20 s (`CacheService`, bounded in-memory TTL).
- Hotspots list (30 s) and leaderboard (5 min) cached; invalidated on create/check-in.
- Global gzip (`compression`) on API responses; static uploads get `max-age: 1d` in
  production.
- Indexes added: `Post(likesCount, createdAt)` and
  `Hotspot(province, category, checkInsCount)` → `prisma migrate dev --name add_perf_indexes`.
- `CacheService` unit-tested (TTL expiry, group invalidation, bounded size).

### New tests

- `src/common/cache.service.spec.ts` — 8 unit tests.
- `test/security.e2e-spec.ts` — self-skipping unless `E2E_BASE_URL` is set:
  header presence, ADMIN-signup rejection, no `passwordHash`/`twoFactorSecret`
  in any response, 413 on oversized body, 429 under auth-burst.

## Deployment checklist

| Item | Value |
|------|-------|
| `JWT_SECRET` | 64+ random chars (`openssl rand -base64 48`) — app refuses to boot in prod without it |
| `SWAGGER_ENABLED` | `false` |
| `TRUST_PROXY` | `1` if behind nginx/traefik/ALB, else `0` |
| `CORS_ORIGINS` | Explicit client origins; **never `*`** |
| `AUTH_RATE_LIMIT_MAX` | 20 / `AUTH_RATE_LIMIT_WINDOW_MS` 60 000 |
| Admin creation | Seeded via `prisma/seed.ts` (`admin@kolab.co.za`) — never via signup |
| `NODE_ENV` | `production` |

## Outstanding / recommended next steps

- CSRF protection for cookie-based sessions if any are introduced (JWT bearer today → not needed).
- Signed upload URLs (S3/R2 presign) instead of streaming through the API when storage is moved
  off local disk — already scaffolded (`uploads/presign`).
- Regular `npm audit` / Dependabot; move to Prisma 7 when feasible to clear the remaining
  CLI-toolchain advisories. `uuid` advisories are benign (bound provided buffers unused).
- Capacity: `CacheService` is process-local; plan Redis + `@nestjs/cache-manager` when running
  more than one API replica.
- Backup the deals/escrow ledger: see `docs/runbook.md` (backups) and `docs/payments-e2e-checklists.md`.