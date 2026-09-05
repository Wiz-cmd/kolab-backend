# Kolab Backend

Backend API for **Kolab** – South African content creator & model platform.

## Stack
- NestJS (Node.js)
- Prisma + PostgreSQL (versioned migrations)
- JWT Auth (access + refresh tokens) + Role-Based Access Control
- Socket.io real-time chat (authenticated)
- File uploads
- Escrow-ready deals (20% platform fee) with PayFast webhook + idempotency

## Features
- Auth: register, login, **refresh tokens**, **logout/logout-all**, **password reset**,
  **email verification**, **account lockout** after repeated failed logins
- **Role-based authorization** via `@Roles(...)` guard; admins can moderate
- Users & profiles, portfolio, measurements, rates
- **Follow / unfollow** + followers/following lists
- Feed posts + likes + the "For You" recommender
- Hotspots + check-ins + Provincial Leaderboard + **pagination**
- **Deals** with automatic 20% platform fee, full status state-machine,
  disputes, refunds, and payment release
- **Payments**: PayFast ITN webhook + **Ozow checkout** (second rail), both with
  **signature verification + idempotency**; brand-initiated funding redirect
- **Withdrawals/Payouts**: request → reserve → approve → paid/fail (auto refund)
- **Contracts**: generate & store a per-deal contract (PDF via pdfkit, HTML fallback)
- **Push notifications**: FCM via firebase-admin, wired into in-app notifications,
  device-token registration
- **Background jobs**: scheduled leaderboard recompute + in-process queue
- **Image processing**: auto compress/resize uploads with sharp
- **Observability**: structured JSON logs, optional Sentry error tracking, `/metrics`
- **OpenAPI/Swagger**: interactive docs at `/api/docs`
- **Admin**: ban/unban, delete posts, adjust balance, resolve reports, list disputes
- **Reports**: report users/posts with triage workflow
- **Notifications** store (in-app), wired into deals/follow/disputes
- Real-time **authenticated** chat with read receipts + history endpoint
- Global exception filter (consistent error shape), request-ID logging,
  security headers, rate limiting, DB-aware health check
- Versioned Prisma migrations + seed script

## Requirements
- Node.js 18+
- PostgreSQL 14+

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set:
#   DATABASE_URL, JWT_SECRET (use `openssl rand -hex 64`)
#   Optionally: S3_* (storage), SMTP_* (email)

# 3. Create + migrate the database (use MIGRATIONS, not db push, in prod)
npx prisma generate
npx prisma migrate dev --name init   # applies schema + creates baseline migration

# 4. (Optional) seed provinces, hotspots, demo users
npm run seed

# 5. Run
npm run start:dev
```

> Production deploys should run `npx prisma migrate deploy` (not `db push`) and
> use a stage-specific env file (`.env.production`).

## Tests

Unit tests are included across payments (webhook security/idempotency), deals
(escrow release), auth (registration/login/lockout/refresh/reset), withdrawals
(reserve/approve/refund), chat (participant auth), and storage (local fallback):

```bash
npm test              # run once
npm run test:watch    # run on change
npm run test:cov      # with coverage
npm run typecheck     # tsc --noEmit, no build output
```

These run without external services (DB, SMTP, S3, PayFast, Firebase are all mocked).

## API Prefix
All routes are served under **`/api`** (e.g. `POST /api/auth/login`).
Health check: `GET /api/health`.

## Main Endpoints

### Auth
- `POST /api/auth/register` – `{ email, password, name, role?, location? }`
- `POST /api/auth/login` – `{ email, password }` → `{ accessToken, refreshToken }`
- `POST /api/auth/refresh` – `{ refreshToken }` (rotates token)
- `POST /api/auth/logout` – `{ refreshToken? }`
- `POST /api/auth/logout-all` – (auth)
- `POST /api/auth/change-password` – (auth) `{ currentPassword, newPassword }`
- `POST /api/auth/request-password-reset` – `{ email }`
- `POST /api/auth/reset-password` – `{ token, newPassword }`
- `POST /api/auth/verify-email` – (auth) `{ token }`

### Users
- `GET /api/users` – query: `role`, `location`, `search`, `take`, `skip`
- `GET /api/users/me` – (auth)
- `GET /api/users/:id`
- `PATCH /api/users/me` – (auth)
- `POST /api/users/me/portfolio` – (auth)
- `POST /api/users/:id/follow`, `DELETE /api/users/:id/follow` – (auth)
- `GET /api/users/:id/followers`, `GET /api/users/:id/following`

### Posts
- `GET /api/posts/feed`, `GET /api/posts/feed/for-you`, `.../for-you/public`
- `POST /api/posts` – (auth)
- `POST /api/posts/:id/like`, `.../view`, `.../collab-tap` – (auth)
- `DELETE /api/posts/:id` – (auth, author or admin)
- `GET /api/posts/interests/me` – (auth)

### Hotspots
- `GET /api/hotspots?province=&category=&city=&take=&skip=`
- `GET /api/hotspots/leaderboard?month=`
- `POST /api/hotspots` – (auth)
- `POST /api/hotspots/:id/checkin` – (auth)

### Deals
- `POST /api/deals` – (Brand) creates deal + 20% fee
- `GET /api/deals` – (auth) my deals, paginated
- `GET /api/deals/:id` – (auth participant)
- `PATCH /api/deals/:id/status` – (auth, state-machine enforced)
- `POST /api/deals/:id/dispute` – (auth participant)
- `POST /api/deals/:id/release` – (Brand/Admin) releases escrow to creator
- `POST /api/admin/deals/:id/refund` – (Admin) refund escrow to brand

### Payments
- `POST /api/payments/webhook/payfast` – PayFast ITN (plain-text `OK`)
- `GET /api/payments/payfast/fund/:dealId` – (Brand) build PayFast redirect
- `POST /api/payments/webhook/ozow` – Ozow notification (returns `OK`/`ERROR`)
- `GET /api/payments/ozow/fund/:dealId` – (Brand) build Ozow checkout (POST form)

### Contracts
- `POST /api/contracts/deals/:dealId` – (auth participant) generate/store contract
- `GET /api/contracts/deals/:dealId` – (auth participant) fetch contract

### Chat (WebSocket)
- Connect to `ws://localhost:3000/chat` with auth token in handshake
  (`auth: { token }` or Bearer header)
- Events: `joinDeal`, `sendMessage`, `newMessage`, `markRead`, `readReceipt`
- `GET /api/deals/:dealId/messages` – (auth) history, `?take=&before=`

### Notifications
- `GET /api/notifications`, `GET /api/notifications/unread-count`,
  `PATCH /api/notifications/read-all`, `PATCH /api/notifications/:id/read` – (auth)
- `POST /api/notifications/devices` – (auth) register an FCM device token
- `DELETE /api/notifications/devices/:token` – (auth) unregister

### Ops
- `GET /api/health` – DB health
- `GET /api/metrics` – lightweight Prometheus-style process metrics
- `GET /api/docs` – Swagger UI (enable with `SWAGGER_ENABLED=true`)

### Reports
- `POST /api/reports/user/:id`, `POST /api/reports/post/:id`, `GET /api/reports/me` – (auth)

### Withdrawals
- `POST /api/withdrawals` – (auth) request payout `{ amount, method, details? }`
- `GET /api/withdrawals/me` – (auth)
- `GET /api/admin/withdrawals`, `POST /api/admin/withdrawals/:id/approve`,
  `POST /api/admin/withdrawals/:id/paid`, `POST /api/admin/withdrawals/:id/fail` – (admin)

### Admin (ADMIN role)
- `POST /api/admin/users/:id/ban`, `POST /api/admin/users/:id/unban`
- `POST /api/admin/posts/:id/delete`
- `POST /api/admin/users/:id/balance` – adjust balance
- `PATCH /api/admin/reports/:id/resolve` – action: `dismiss | warn | ban`
- `GET /api/admin/disputes`

### Uploads
- `POST /api/uploads` – (auth) multipart field: `file` (images/videos ≤ 15 MB).
  Images are auto-compressed/resized via sharp when `IMAGE_PROCESSING=true`.

## Auth Header
Send the short-lived access token:
```
Authorization: Bearer <accessToken>
```
When it expires (default 1h), use `/api/auth/refresh` with your `refreshToken`
(valid 30 days, rotated on each use) to get a new pair.

## Error Shape
Every response (success or failure) is stable; errors look like:
```json
{
  "statusCode": 400,
  "message": "human readable",
  "error": "MachineName",
  "requestId": "uuid",
  "path": "/api/...",
  "timestamp": "ISO8601"
}
```

## Payments Notes
- PayFast posts ITNs to `/api/payments/webhook/payfast`. The service verifies
  the MD5 signature (using `PAYFAST_PASSPHRASE`) and is idempotent via the
  `webhook_events` table, so provider retries are safe.
- Only `payment_status=COMPLETE` moves a deal to `HELD_IN_ESCROW`; the brand
  (or admin) then calls release to pay out the creator (minus the 20% platform fee).
- Webhook responses: return `OK` (retries stop) or `ERROR` (PayFast retries).

### PayFast Sandbox E2E
1. Create a PayFast sandbox account at https://sandbox.payfast.co.za and add a
   test merchant/credentials. Put `merchant_id`, `merchant_key` and `passphrase`
   into `.env` and point `PAYFAST_BASE_URL` at the sandbox process URL.
2. `GET /api/payments/payfast/fund/:dealId` (as the deal's brand) → returns the
   redirect URL.
3. Complete the sandbox checkout (use PayFast's test card). PayFast posts an ITN
   to `/api/payments/webhook/payfast` (must be reachable over HTTPS for the
   sandbox, e.g. `ngrok http 3000`).
4. Verify the deal is now `HELD_IN_ESCROW` and the payment appears in the
   `webhook_events` and `deals` rows.
5. `POST /api/deals/:id/release` (brand/admin) → credits the creator balance,
   deal becomes `COMPLETED`.

### Withdrawals / Payouts
- `POST /api/withdrawals` – user requests a payout; funds are reserved (debited)
  and status becomes `PENDING`.
- `GET /api/withdrawals/me` – user's history.
- Admin: `GET /api/admin/withdrawals`, `POST /api/admin/withdrawals/:id/approve`,
  `POST /api/admin/withdrawals/:id/paid`, `POST /api/admin/withdrawals/:id/fail`.
- The approve step is where you plug in the PayFast/Ozow payout API. On failure
  the reserved funds are returned to the user's balance automatically.

## Object Storage (S3 / Cloudflare R2)
Uploads POST to `/api/uploads` and stream to the configured bucket (S3 or R2
via its S3-compatible endpoint). If `S3_BUCKET` is empty the service falls back
to local disk under `UPLOAD_DIR` for development. `GET /api/uploads/presign?key=`
returns a short-lived read URL for private objects.

## Email (reset / verify)
Password-reset and email-verification links are sent via SMTP (`MAIL_DRIVER=smtp`).
With `MAIL_DRIVER=console` (default) or no `SMTP_HOST`, emails are logged to the
console and the raw reset/verify token is returned in dev
(`MAIL_DEV_RETURN_TOKENS=true`) so flows can be tested without an email provider.

### Ozow Sandbox Notes
- `GET /api/payments/ozow/fund/:dealId` (as the deal's brand) returns `{ url, params }`.
  Point the client at `url` and POST the `params` form (Ozow-hosted checkout) — set
  `OZOW_API_URL` to `https://test.ozow.com` in dev and `https://pay.ozow.com` in prod.
- Signature = MD5 of
  `MerchantCode + SiteCode + CountryCode + CurrencyCode + Amount + TransactionReference +
  BankReference + CancelUrl + ErrorUrl + SuccessUrl + NotifyUrl + PrivateKey`,
  where `CountryCode`/`CurrencyCode` are both `ZAR`.
- Ozow posts a notification to `/api/payments/webhook/ozow`; a status of `complete`
  moves the deal funds into escrow. Reply `OK` to stop retries.

### Push (FCM)
Install `firebase-admin`, set `FIREBASE_SERVICE_ACCOUNT` (path or inline JSON). The client
registers its token via `POST /api/notifications/devices`. Every in-app notification made
through `NotificationsService.create` also triggers a push to the user's devices when
Firebase is configured; otherwise it silently degrades to in-app only.

## Connecting Android App
1. Base URL: emulator `http://10.0.2.2:3000` + prefix `/api`
2. After login store `accessToken` + `refreshToken`; refresh proactively on 401.
3. Pass the access token to both REST calls (Bearer) and the Socket.io handshake.
4. See **docs/android-refresh.md** for the full 401 → `/api/auth/refresh` single-flight flow.

## 2FA (Authenticator app)
Enabled per user via TOTP (otplib). Endpoints under `/api/auth`:
- `POST /api/auth/2fa/setup` → `{ secret, otpauthURL }`
- `POST /api/auth/2fa/enable` `{ secret, code }`
- `POST /api/auth/2fa/disable` `{ code }`
- `POST /api/auth/login` `{ email, password, twoFactorCode? }` — include the code when enabled.

## Product features (verification, alerts, pricing, collections, analytics, moderation)
| Area | Endpoints | Models |
|------|-----------|--------|
| **Verified badge** | `/api/verification` (submit / me), `/api/admin/verification/*` | `Verification` + `User.verificationStatus` |
| **Saved alerts** | `/api/alerts` (CRUD) — auto-matched on new posts | `SavedSearch` |
| **Rate cards** | `/api/pricing/rate-cards` | `RateCard` |
| **Portfolio collections** | `/api/collections` (+ add/remove item) | `PortfolioCollection` |
| **Analytics** | `/api/analytics` (record + summary) | `AnalyticsEvent` |
| **Moderation** | auto-flag on create (`scoreContent`) + `/api/admin/moderation` (queue + review) | `Publication` + `ModerationStatus` |

All run as independent modules wired into `AppModule`; posts trigger moderation + alerts on create.

## Migrations
Committed under `prisma/migrations/`:
- `20260827000000_init` — full baseline DDL.
- `20260827100000_add_products_features` — verification, alerts, rate cards, collections,
  analytics, moderation, 2FA fields, contracts/push additions.

Apply in production/CI with `npx prisma migrate deploy` (non-interactive). See **docs/runbook.md**
for rollback, backups, and incident procedures.

## Ops
- **Docker**: `docker compose up --build` runs Postgres + migrate + API (see `Dockerfile`, `docker-compose.yml`).
- **CI**: `.github/workflows/ci.yml` — install → generate → typecheck → build → unit tests → `migrate deploy`.
- **Backups**: `scripts/backup.sh` / `scripts/restore.sh` (pg_dump + gzip, 14-day retention). See **docs/runbook.md**.
- **Payout driver**: `PAYOUT_DRIVER=mock|ozow|payfast` drives withdrawals on admin approve
  (a provider rejection auto-fails and refunds the reserved balance).
- **Payments E2E**: **docs/payments-e2e-checklists.md** covers both PayFast and Ozow rails on a deployed HTTPS URL.

