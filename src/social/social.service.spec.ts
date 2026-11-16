import { SocialService } from './social.service';

describe('SocialService', () => {
  const env: Record<string, string> = {};
  const config = { get: (key: string) => env[key] } as any;
  const auth = {} as any;
  let service: SocialService;

  beforeEach(() => {
    for (const key of Object.keys(env)) delete env[key];
    service = new SocialService(config, auth);
  });

  it('normalises the display names the Android app sends', () => {
    expect(SocialService.normaliseProvider('Google')).toBe('google');
    expect(SocialService.normaliseProvider('Instagram')).toBe('instagram');
    expect(SocialService.normaliseProvider('Twitter-X')).toBe('twitter');
    expect(SocialService.normaliseProvider('X')).toBe('twitter');
    expect(SocialService.normaliseProvider(' apple ')).toBe('apple');
  });

  it('reports all providers as unconfigured without credentials', () => {
    const list = service.listProviders();
    expect(list.map((p) => p.provider)).toEqual(['instagram', 'twitter', 'google']);
    expect(list.every((p) => p.configured === false)).toBe(true);
  });

  it('reports a provider as configured only with both credentials', () => {
    env.GOOGLE_CLIENT_ID = 'client-id';
    env.GOOGLE_CLIENT_SECRET = 'secret';
    expect(service.listProviders().find((p) => p.provider === 'google')?.configured).toBe(true);
  });

  it('start() canonicalises the provider name', async () => {
    env.GOOGLE_CLIENT_ID = 'client-id';
    env.GOOGLE_CLIENT_SECRET = 'secret';
    const result = await service.start('Google');
    expect(result.configured).toBe(true);
    expect(result.provider).toBe('google');
    expect(result.authUrl).toContain('accounts.google.com');
    expect(result.state).toBeTruthy();
  });
});
