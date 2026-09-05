# Android: Automatic token refresh on 401

The Kolab API uses short-lived access tokens (default 1h) plus rotating refresh
tokens (30 days). When an access token expires the API returns `401`. The client
must transparently call `POST /api/auth/refresh` with the stored refresh token,
get a new pair, and retry the original request — exactly once.

Backend contract (already implemented):

- `POST /api/auth/login` → `{ accessToken, refreshToken }`
- `POST /api/auth/refresh` `{ refreshToken }` → `{ accessToken, refreshToken }`
  (rotates: the old refresh token is revoked, a new one issued)
- Storage: access token in memory; refresh token in EncryptedSharedPreferences.

## Recommended flow (single-flight refresh)

```text
Request with accessToken
   │
   ├─ 200 → done
   │
   └─ 401 → is this a refresh retry? ── yes ──→ surface error ("session expired"),
          │                                        prompt re-login
          no
          └─ single-flight refresh
               │  lock = mutex
               ├─ if refresh already in-flight → await its result
               └─ if not → call POST /auth/refresh
                    ├─ 200 → store new pair, release lock, retry original request
                    └─ 401/403 → clear tokens, release lock, force re-login
```

Key rules to avoid loops and token thrash:

1. **Single-flight**: only one refresh at a time. Concurrent 401s share the same
   in-flight refresh (an OkHttp `Authenticator` + a shared `CompletableDeferred`,
   or a `Flow`/`Mutex`).
2. **Retry once**: track `isRetry` per request so a 401 on the *refreshed*
   request doesn't trigger another refresh and loop.
3. **Handle revoke-on-rotation**: because refresh tokens rotate, never send the
   *same* refresh token twice. If a request reused an old token, the API may
   reject it — always store the newest token immediately after a successful
   refresh.
4. **Logout-all / 2FA**: if refresh returns `403` (e.g. account suspended or all
   sessions revoked) treat it as a hard logout, clear local tokens, and send the
   user to login.

## OkHttp `Authenticator` sketch (Kotlin)

```kotlin
class TokenAuthenticator internal constructor(
    private val session: SessionStore,       // holds access+refresh, thread-safe
    private val api: AuthApi,
    private val refreshLock: Any = Any(),
    @Volatile private var inflight: CompletableDeferred<Boolean>? = null,
) : Authenticator {

    override fun authenticate(route: Route, response: Response): Request? {
        // Only handle 401 from our own API (not auth endpoints).
        if (response.request.header("Authorization") == null) return null
        if (response.request.url.encodedPath == "/api/auth/refresh") return null

        val ok = refreshNow()
        if (!ok) return null // forces caller to handle auth failure
        return response.request.newBuilder()
            .header("Authorization", "Bearer ${session.accessToken()}")
            .build()
    }

    private fun refreshNow(): Boolean {
        synchronized(refreshLock) {
            inflight?.let { return it.await() }
            val deferred = CompletableDeferred<Boolean>()
            inflight = deferred
            try {
                val resp = api.refresh(session.refreshToken()).execute()
                if (resp.isSuccessful && resp.body() != null) {
                    session.update(resp.body()!!)
                    deferred.complete(true)
                } else {
                    session.clear()
                    deferred.complete(false)
                }
            } catch (t: Throwable) {
                deferred.complete(false)
            } finally {
                inflight = null
            }
            return deferred.await()
        }
    }
}
```

> Use Coroutines for the network calls; the sketch uses a blocking `execute()`
> for brevity. Interceptors run on OkHttp's IO threads, so blocking is acceptable
> but prefer `asyncThread`/coroutines where convenient.

## Token storage (EncryptedSharedPreferences)

- `accessToken`: plain in-memory only (never persisted to disk).
- `refreshToken`: `EncryptedSharedPreferences` (AndroidX Security Crypto).
- On `logout`, call `POST /api/auth/logout { refreshToken }` then clear.

## 2FA-enabled accounts
- Login for a 2FA-enabled account must include `{ email, password, twoFactorCode }`.
- If `twoFactorCode` is missing/incorrect the API returns `401` — do **not** fall
  into the refresh path (there is no refresh token yet); prompt for the code.
