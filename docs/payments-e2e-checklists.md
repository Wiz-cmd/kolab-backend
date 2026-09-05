# PayFast + Ozow Sandbox E2E Checklist

Goal: prove **both rails** end-to-end once, against a **deployed HTTPS URL**
(Prod.-like). Use `ngrok http 3000` (or a staging host) so the payment providers
can reach your webhooks.

## 0. Prereqs (deployed URL)

1. Deploy this backend (Docker Compose or your host) with an HTTPS URL, e.g.
   `https://<you>.ngrok.io`. Set in `.env`:
   ```
   APP_BASE_URL=https://<you>.ngrok.io
   CORS_ORIGINS=https://app.kolab.co.za
   ```
2. Restart the API so webhook notify URLs embed the new host.
3. Confirm webhooks reachable:
   - `curl https://<you>.ngrok.io/api/health`
   - `curl -X POST https://<you>.ngrok.io/api/payments/webhook/payfast -H 'Content-Type: application/x-www-form-urlencoded' -d 'x=1'` → `ERROR`

## 1. Auth + a deal to fund

- Register two users: `POST /api/auth/register` (one BRAND, one CREATOR).
- As brand, create a deal: `POST /api/deals` `{ creatorId, title, amount }`.

## 2. PayFast rail

| Step | Action | Check |
|------|--------|-------|
| A | `GET /api/payments/payfast/fund/:dealId` (brand token) | returns `redirect_url` (sandbox URL) |
| B | Open redirect, pay with PayFast **sandbox test card** | payment completes |
| C | PayFast posts ITN to `/api/payments/webhook/payfast` | `200 OK`; `webhook_events` row `payfast:...:COMPLETE` PROCESSED |
| D | `GET /api/deals/:dealId` | `paymentStatus = HELD_IN_ESCROW`, `amountPaid` set |
| E | `POST /api/deals/:id/release` (brand) | deal `COMPLETED`, creator balance credited (`20%` fee deducted) |
| F | Re-send the same ITN (simulate retry) | idempotent: no double credit |

**Footgun check:** with `PAYFAST_BASE_URL` pointing at sandbox and a test
merchant, sign with `PAYFAST_PASSPHRASE`; a bad signature must be ignored.

## 3. Ozow rail

| Step | Action | Check |
|------|--------|-------|
| A | `GET /api/payments/ozow/fund/:dealId` (brand token) | returns `{ url, params }` with `hash` |
| B | POST the form to Ozow (test/QA) | Ozow-hosted checkout opens |
| C | Complete checkout (test bank) | Ozow posts to `/api/payments/webhook/ozow` |
| D | Your notify URL receives status `Complete` | handler returns `OK` |
| E | `GET /api/deals/:dealId` | `paymentStatus = HELD_IN_ESCROW` |
| F | Re-send a `Complete` notify (idempotency) | no duplicate `markPaidInEscrow` |

**Signature check (Ozow):**
`MD5(MerchantCode + SiteCode + 'ZAR' + 'ZAR' + Amount + TransactionReference +
BankReference + CancelUrl + ErrorUrl + SuccessUrl + NotifyUrl + PrivateKey)`.

Set `OZOW_API_URL=https://test.ozow.com`, `OZOW_TEST=true`.

## 4. Payout (withdraw) — same deployed URL

- As creator: `POST /api/withdrawals` `{ amount, method: 'bank', details: { bank: {...} } }`
  → `PENDING`, balance reserved.
- As admin: `POST /api/admin/withdrawals/:id/approve` → dispatches provider
  (or `PAYOUT_DRIVER=mock` returns a `PY-...` ref) → `PROCESSING`.
- `POST /api/admin/withdrawals/:id/paid` → `PAID`.
- `POST /api/admin/withdrawals/:id/fail` → refunds reserved funds to balance.

## 5. Sign-off

Run the checklist with both rails on the SAME deployed URL and record:
- git SHA, env (sandbox flags), webhook timestamps, deal IDs, amounts, fee/ref.
Keep the `.env` sandbox values in a screenshot/commit note (never commit secrets).
