import { ConfigService } from '@nestjs/config';

const DEV_FALLBACK_SECRET = 'kolab-dev-secret-change-me';
const MIN_SECRET_LENGTH = 32;

/**
 * Resolves the JWT signing secret for the app, enforcing a safe configuration.
 *
 * In development/test the well-known fallback is allowed so the app boots
 * without setup. In production the process refuses to start unless a strong,
 * non-default JWT_SECRET is set: silently falling back to a public constant
 * there would let anyone forge tokens for any account (including admins).
 */
export function jwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET');
  const env = config.get<string>('NODE_ENV') || 'development';

  if (env === 'production') {
    if (!secret || secret === DEV_FALLBACK_SECRET || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        'JWT_SECRET must be set to a strong, unique value (>= 32 chars) in production. ' +
          'Generate one with: openssl rand -hex 64',
      );
    }
    return secret;
  }

  return secret || DEV_FALLBACK_SECRET;
}