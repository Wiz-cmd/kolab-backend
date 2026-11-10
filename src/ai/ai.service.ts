import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

const DEFAULT_BASE_URL = 'https://models.github.ai/inference';
const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const MAX_INPUT_CHARS = 1000;

/**
 * Thin, dependency-free client for an OpenAI-compatible chat endpoint.
 *
 * Defaults target GitHub Models, which is free to use with a GitHub token
 * (PAT with `models:read`). Any OpenAI-compatible provider can be used by
 * setting AI_BASE_URL / AI_MODEL, so the app is not locked in.
 *
 * The module is fully env-gated: with no token, AI endpoints return 503 and
 * the rest of the API behaves exactly as before.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly token: string;
  private readonly baseUrl: string;
  readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.token =
      this.config.get<string>('GITHUB_MODELS_TOKEN') ||
      this.config.get<string>('GITHUB_TOKEN') ||
      '';
    this.baseUrl = (this.config.get<string>('AI_BASE_URL') || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.model = this.config.get<string>('AI_MODEL') || DEFAULT_MODEL;
    this.timeoutMs = Number(this.config.get<string>('AI_TIMEOUT_MS') || 20000);
  }

  isConfigured(): boolean {
    return this.token.trim().length > 0;
  }

  status() {
    return {
      configured: this.isConfigured(),
      provider: 'github-models',
      model: this.model,
      baseUrl: this.baseUrl,
    };
  }

  /** Generate a caption + hashtags for a creator post. */
  async generateCaption(input: {
    topic: string;
    tone?: string;
    platform?: string;
  }): Promise<{ caption: string; hashtags: string[] }> {
    const topic = this.clean(input.topic);
    const tone = this.clean(input.tone || 'confident, creative');
    const platform = this.clean(input.platform || 'Instagram');

    const content = await this.chat(
      [
        {
          role: 'system',
          content:
            'You write short, high-converting social captions for South African creators and brands. ' +
            'Reply with strict JSON only: {"caption": string, "hashtags": string[]}. ' +
            'Keep the caption under 220 characters, use at most 8 relevant hashtags, ' +
            'and never include markdown fences.',
        },
        {
          role: 'user',
          content: `Platform: ${platform}\nTone: ${tone}\nTopic: ${topic}`,
        },
      ],
      { temperature: 0.8, maxTokens: 300, json: true },
    );

    const parsed = this.parseJson<{ caption?: unknown; hashtags?: unknown }>(content);
    const caption = typeof parsed.caption === 'string' ? parsed.caption.trim() : '';
    const hashtags = Array.isArray(parsed.hashtags)
      ? parsed.hashtags.filter((h): h is string => typeof h === 'string').map((h) => (h.startsWith('#') ? h : `#${h}`)).slice(0, 8)
      : [];

    if (!caption) throw new BadGatewayException('AI returned an empty caption');
    return { caption, hashtags };
  }

  /** Generate a profile bio for a creator. */
  async generateBio(input: {
    name?: string;
    niche?: string;
    location?: string;
    keywords?: string;
  }): Promise<{ bio: string }> {
    const parts = [
      input.name ? `Name: ${this.clean(input.name)}` : null,
      input.niche ? `Niche: ${this.clean(input.niche)}` : null,
      input.location ? `Location: ${this.clean(input.location)}` : null,
      input.keywords ? `Keywords: ${this.clean(input.keywords)}` : null,
    ].filter(Boolean);

    if (parts.length === 0) {
      throw new BadGatewayException('Provide at least one of name, niche, location or keywords');
    }

    const content = await this.chat(
      [
        {
          role: 'system',
          content:
            'You write first-person creator bios for a South African creator marketplace. ' +
            'Reply with strict JSON only: {"bio": string}. Max 280 characters, warm and professional, ' +
            'no hashtags, no markdown fences.',
        },
        { role: 'user', content: parts.join('\n') },
      ],
      { temperature: 0.7, maxTokens: 220, json: true },
    );

    const parsed = this.parseJson<{ bio?: unknown }>(content);
    const bio = typeof parsed.bio === 'string' ? parsed.bio.trim() : '';
    if (!bio) throw new BadGatewayException('AI returned an empty bio');
    return { bio };
  }

  private async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'AI is not configured. Set GITHUB_MODELS_TOKEN (free GitHub Models token with models:read).',
      );
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 400,
    };
    if (options.json) body.response_format = { type: 'json_object' };

    const data = await this.requestWithRetry(body);
    const raw = data?.choices?.[0]?.message?.content;

    const text = Array.isArray(raw)
      ? raw.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
      : typeof raw === 'string'
        ? raw
        : '';

    if (!text.trim()) {
      this.logger.warn('AI provider returned an empty message');
      throw new BadGatewayException('AI provider returned an empty response');
    }
    return text;
  }

  private async requestWithRetry(
    body: Record<string, unknown>,
    attempts = 2,
  ): Promise<ChatCompletionResponse> {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          lastError = new Error(`AI provider HTTP ${res.status}`);
          await this.delay(400 * (attempt + 1));
          continue;
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          this.logger.warn(`AI provider HTTP ${res.status}: ${detail.slice(0, 200)}`);
          throw new BadGatewayException('AI provider rejected the request');
        }

        return (await res.json()) as ChatCompletionResponse;
      } catch (error) {
        if (error instanceof BadGatewayException) throw error;
        lastError = error;
        if (attempt < attempts - 1) await this.delay(400 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }

    this.logger.warn(`AI request failed: ${(lastError as Error)?.message || 'unknown error'}`);
    throw new BadGatewayException('AI provider is unavailable right now');
  }

  private parseJson<T>(text: string): T {
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new BadGatewayException('AI returned malformed JSON');
    }
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    } catch {
      throw new BadGatewayException('AI returned malformed JSON');
    }
  }

  private clean(value: string): string {
    return String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_INPUT_CHARS);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
