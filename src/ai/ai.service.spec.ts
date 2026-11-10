import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from './ai.service';

const makeConfig = (values: Record<string, string | undefined>) => ({
  get: jest.fn((key: string) => values[key]),
});

const createService = (values: Record<string, string | undefined>) =>
  new AiService(makeConfig(values) as unknown as ConfigService);

describe('AiService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('reports unconfigured when no token is present', () => {
    const svc = createService({});
    expect(svc.isConfigured()).toBe(false);
    expect(svc.status()).toMatchObject({ configured: false, model: 'openai/gpt-4o-mini' });
  });

  it('refuses to call the provider when unconfigured', async () => {
    const svc = createService({});
    await expect(svc.generateCaption({ topic: 'Cape Town sunset shoot' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('generates a caption with hashtags from provider JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"caption":"Golden hour in Cape Town","hashtags":["capetown","creators"]}',
            },
          },
        ],
      }),
    }) as unknown as typeof fetch;

    const svc = createService({ GITHUB_MODELS_TOKEN: 'test-token' });
    const result = await svc.generateCaption({ topic: 'Cape Town sunset shoot', tone: 'warm' });

    expect(result.caption).toBe('Golden hour in Cape Town');
    expect(result.hashtags).toEqual(['#capetown', '#creators']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('strips markdown fences from the model reply', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '```json\n{"bio":"I create bold visuals."}\n```' } }],
      }),
    }) as unknown as typeof fetch;

    const svc = createService({ GITHUB_MODELS_TOKEN: 'test-token' });
    await expect(svc.generateBio({ niche: 'photography' })).resolves.toEqual({
      bio: 'I create bold visuals.',
    });
  });

  it('retries once on a 5xx then succeeds', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"bio":"Hi"}' } }] }),
      }) as unknown as typeof fetch;

    const svc = createService({ GITHUB_MODELS_TOKEN: 'test-token' });
    await expect(svc.generateBio({ name: 'Wiz' })).resolves.toEqual({ bio: 'Hi' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed model output', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'not-json' } }] }),
    }) as unknown as typeof fetch;

    const svc = createService({ GITHUB_MODELS_TOKEN: 'test-token' });
    await expect(svc.generateBio({ name: 'Wiz' })).rejects.toBeInstanceOf(BadGatewayException);
  });
});
