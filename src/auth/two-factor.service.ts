import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as otplib from 'otplib';

/**
 * Optional TOTP-based 2FA for brands/admins.
 *
 * Uses `otplib`. Setup:
 *   1. enable() returns a secret + otpauth URL (store secret on user).
 *   2. User verifies a code -> twoFactorEnabled = true.
 *   3. On login, a user with 2FA must present a code (passed via login).
 *   4. disable() clears the secret after verifying a code.
 */
@Injectable()
export class TwoFactorService {
  constructor(private config: ConfigService) {}

  enable(issuer = this.config.get('APP_NAME') || 'Kolab', account?: string) {
    const secret = otplib.authenticator.generateSecret();
    const otpauth = otplib.authenticator.keyuri(account || 'user', issuer, secret);
    return { secret, otpauth };
  }

  verify(secret: string, token: string): boolean {
    if (!token || !secret) return false;
    try {
      return otplib.authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  }

  requireVerified(secret: string, token: string) {
    if (!this.verify(secret, token)) {
      throw new UnauthorizedException('Invalid 2FA code');
    }
    return true;
  }

  requireToken(token: string) {
    if (!token) throw new BadRequestException('2FA code is required');
    return token;
  }
}
