import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';

/**
 * Lightweight OAuth2 (PKCE) provider scaffold for Instagram and Twitter/X.
 *
 * This deliberately ships as a scaffold: it only activates when the matching
 * provider credentials exist in the environment. Until then `start()` returns
 * `{ configured: false }` and the app shows the "not configured" state.
 *
 * Notes for wiring up real clients:
 *  - X (Twitter) requires PKCE; Instagram classic code flow accepts verifiers
 *    but ignores them, so a single exchange path handles both.
 *  - Email is not always granted (X is known for this). Accounts without a
 *    provider email key on a scoped `@instagram.kolab` / `@x.kolab` handle so
 *    repeated logins still resolve to the same local account.
 *  - `state` is stored in-memory only; add a persistent/sharded store if you
 *    run multiple instances.
 */
@Injectable()
export class SocialService {
  private readonly redirectUri: string;
  private readonly pending = new Map<
    string,
    { provider: string; verifier: string; createdAt: number }
  >();

  private static readonly PROVIDERS = {
    instagram: {
      authorizeUrl: 'https://api.instagram.com/oauth/authorize',
      tokenUrl: 'https://api.instagram.com/oauth/access_token',
      userinfoUrl: 'https://graph.instagram.com/me',
      scope: 'instagram_business_basic,instagram_business_manage_messages,business_management',
      usesBasicAuth: false,
    },
    twitter: {
      authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
      tokenUrl: 'https://api.twitter.com/2/oauth2/token',
      userinfoUrl: 'https://api.twitter.com/2/users/me?user.fields=profile_image_url,username',
      scope: 'tweet.read users.read offline.access',
      usesBasicAuth: true,
    },
  } as const;

  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {
    this.redirectUri =
      this.config.get('SOCIAL_REDIRECT_URL') || 'kolab://auth/callback';
  }

  private credentials(provider: string) {
    const prefix = provider === 'twitter' ? 'X' : 'INSTAGRAM';
    const clientId = this.config.get(`${prefix}_CLIENT_ID`)?.trim();
    const clientSecret = this.config.get(`${prefix}_CLIENT_SECRET`)?.trim();
    const spec = SocialService.PROVIDERS[provider as keyof typeof SocialService.PROVIDERS];
    return {
      spec,
      clientId,
      clientSecret,
      isConfigured: !!(spec && clientId && clientSecret),
    };
  }

  async start(provider: string) {
    const cfg = this.credentials(provider);
    if (!cfg.isConfigured) {
      return { configured: false, provider };
    }

    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { provider, verifier, createdAt: Date.now() });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId!,
      redirect_uri: this.redirectUri,
      scope: cfg.spec.scope,
      state,
    });

    // X enforces PKCE; the verifier is stored in `pending` and sent back at
    // exchange time. Instagram ignores these params, so one path serves both.
    if (provider === 'twitter') {
      params.set(
        'code_challenge',
        createHash('sha256').update(verifier).digest('base64url'),
      );
      params.set('code_challenge_method', 'S256');
    }

    return {
      configured: true,
      provider,
      authUrl: `${cfg.spec.authorizeUrl}?${params.toString()}`,
      state,
    };
  }

  async exchange(
    provider: string,
    code: string,
    state: string,
    ip?: string,
    userAgent?: string,
  ) {
    const cfg = this.credentials(provider);
    if (!cfg.isConfigured) {
      throw new ServiceUnavailableException(`${provider} login is not configured on the server`);
    }

    const pending = this.pending.get(state);
    if (!pending || pending.provider !== provider) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      this.pending.delete(state);
      throw new BadRequestException('OAuth state expired');
    }
    this.pending.delete(state);

    const accessToken = await this.requestAccessToken(cfg, code, pending.verifier);
    const profile = await this.fetchProfile(cfg, accessToken);

    return this.auth.loginWithProvider(
      profile.email,
      profile.name,
      profile.avatarUrl,
      ip,
      userAgent,
    );
  }

  private async requestAccessToken(
    cfg: { spec: any; clientId: string; clientSecret: string },
    code: string,
    verifier: string,
  ) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: cfg.clientId,
    });

    if (cfg.spec.usesBasicAuth) {
      // X: client-authenticates via HTTP Basic (client_id:secret) + PKCE.
      body.set('code_verifier', verifier);
      const basic = Buffer.from(
        `${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`,
      ).toString('base64');
      const res = await fetch(cfg.spec.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${basic}`,
        },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new BadRequestException(`Token exchange failed: ${data.error_description || data.error || res.statusText}`);
      return data.access_token;
    }

    // Instagram: client_id + client_secret in the form body, no PKCE.
    body.set('client_secret', cfg.clientSecret);
    const res = await fetch(cfg.spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const exchangeResult = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BadRequestException(`Token exchange failed: ${exchangeResult.error_message || res.statusText}`);
    }

    // Instagram returns an access_token + user_id directly.
    if (exchangeResult.access_token) {
      return exchangeResult.access_token;
    }
    throw new BadRequestException('Token exchange failed: no access_token returned');
  }

  private async fetchProfile(
    cfg: { spec: any },
    accessToken: string,
  ): Promise<{ email: string; name: string; avatarUrl?: string }> {
    const res = await fetch(cfg.spec.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new BadRequestException('Failed to fetch provider profile');
    const data = await res.json();

    if (cfg.spec.userinfoUrl.includes('graph.instagram')) {
      // Instagram Basic: username + id only. Real email needs business scope
      // approval; fall back to a scoped handle that is still stable per user.
      const id = String(data.id || '');
      return {
        email: data.email ? String(data.email).toLowerCase() : `${id}@instagram.kolab`,
        name: data.username || `IG ${id}`,
        avatarUrl: data.profile_picture_url || undefined,
      };
    }

    // Twitter/X users/me
    const me = data.data || {};
    const id = String(me.id || '');
    return {
      email: data.email ? String(data.email).toLowerCase() : `${id}@x.kolab`,
      name: me.name || me.username || `X ${id}`,
      avatarUrl: me.profile_image_url?.replace('_normal', '_400x400') || undefined,
    };
  }
}