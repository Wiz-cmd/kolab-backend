/**
 * Live security regression suite. Run against a real booted server:
 *
 *   $env:E2E_BASE_URL='http://localhost:3000'; jest --config jest.config.js test/security.e2e-spec.ts
 *
 * Skips entirely when E2E_BASE_URL is unset so the normal `npm test` run (which
 * has no DB) stays green.
 *
 * AdvancedServerError note: rate-limit tests pollute a shared per-IP window, so
 * the burst test is ordered LAST in this file.
 */

const baseUrl = process.env.E2E_BASE_URL || '';
const runnable = describe;

interface JsonBody {
  [k: string]: unknown;
}

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const uniq = () => `e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

(runnable)('Security e2e', () => {
  (baseUrl ? describe : describe.skip)('against a live server', () => {
    it('exposes security headers on every API response', async () => {
      const res = await fetch(`${baseUrl}/api/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('permissions-policy')).toMatch(/geolocation=\(\)/);
      expect(res.headers.get('x-download-options')).toBe('noopen');
    });

    it('rejects self-service registration as ADMIN', async () => {
      const res = await post('/api/auth/register', {
        email: `${uniq()}@test.local`,
        password: 'CorrectHorse123!',
        name: 'Attacker',
        role: 'ADMIN',
      });
      expect([400, 403]).toContain(res.status);
      const body = (await res.json()) as JsonBody;
      expect(JSON.stringify(body).toLowerCase()).not.toContain('accessToken');
    });

    it('registers a normal account and never returns password hashes', async () => {
      const res = await post('/api/auth/register', {
        email: `${uniq()}@test.local`,
        password: 'CorrectHorse123!',
        name: 'Creator',
        role: 'CREATOR',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as JsonBody;
      const user = body.user as JsonBody;
      expect(user.role).toBe('CREATOR');
      expect(typeof body.accessToken).toBe('string');
      // No password/Hash/twoFactor secret leakage anywhere in the response.
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/password/i);
      expect(serialized).not.toMatch(/twoFactorSecret/i);
    });

    it('does not leak password hashes from the authenticated me endpoint', async () => {
      const email = `${uniq()}@test.local`;
      const reg = await post('/api/auth/register', {
        email,
        password: 'CorrectHorse123!',
        name: 'Model',
        role: 'MODEL',
      });
      expect(reg.status).toBe(201);
      const regBody = (await reg.json()) as JsonBody;

      const me = await fetch(`${baseUrl}/api/users/me`, {
        headers: { Authorization: `Bearer ${regBody.accessToken}` },
      });
      expect(me.status).toBe(200);
      const serialized = JSON.stringify(await me.json());
      expect(serialized).not.toMatch(/password/i);
      // `twoFactorEnabled` boolean is intended public data; the secret is not.
      expect(serialized).not.toMatch(/twoFactorSecret/i);
    });

    it('rejects oversized JSON bodies with 413', async () => {
      const res = await post('/api/auth/register', {
        email: `${uniq()}@test.local`,
        password: 'CorrectHorse123!',
        name: 'X',
        location: 'A'.repeat(5 * 1024 * 1024),
      });
      expect(res.status).toBe(413);
    });

    it('rate-limits repeated authentication attempts (429)', async () => {
      let got429 = false;
      for (let i = 0; i < 30; i++) {
        const res = await post('/api/auth/login', {
          email: `${uniq()}@test.local`,
          password: 'WrongPassword!',
        });
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }
      expect(got429).toBe(true);
    });
  });
});