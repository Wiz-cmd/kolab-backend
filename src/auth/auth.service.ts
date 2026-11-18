import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../mail/sms.service';
import { TwoFactorService } from './two-factor.service';
import { Role, LoginChannel } from '@prisma/client';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const LOGIN_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const LOGIN_OTP_MAX_ATTEMPTS = 5;
const LOGIN_OTP_MAX_RESENDS = 3;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private notifications: NotificationsService,
    private mail: MailService,
    private sms: SmsService,
    private twoFactor: TwoFactorService,
  ) {}

  async register(data: {
    email: string;
    password: string;
    name: string;
    role?: Role;
    location?: string;
    ip?: string;
    userAgent?: string;
  }) {
    const email = data.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('Email already registered');

    const passwordHash = await bcrypt.hash(data.password, 12);

    // Defense in depth: even if a client sneaks `role` past the DTO, the
    // public registration surface can never mint ADMIN accounts.
    const requestedRole = data.role === Role.ADMIN ? undefined : data.role;

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name: data.name,
        role: requestedRole || Role.CREATOR,
        location: data.location,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        location: true,
        avatarUrl: true,
        isVerified: true,
      },
    });

    // Send a verification email with a time-limited token.
    const verificationToken = randomBytes(32).toString('hex');
    await this.prisma.passwordReset.create({
      data: {
        tokenHash: hashToken(verificationToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const base = this.config.get('APP_BASE_URL') || 'http://localhost:3000';
    await this.mail.sendEmailVerification(
      user.email,
      `${base}/verify-email?token=${verificationToken}`,
    );

    const tokens = await this.issueTokens(user.id, data.ip, data.userAgent);

    return {
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      // Only returned in dev so flows can be tested before an SMTP provider is set.
      emailVerificationToken: this.devReturnTokens() ? verificationToken : undefined,
    };
  }

  async login(email: string, password: string, twoFactorCode?: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.isBanned) {
      throw new ForbiddenException('This account has been suspended');
    }

    if (user.lockedUntil) {
      if (user.lockedUntil > new Date()) {
        throw new UnauthorizedException('Account locked. Try again later.');
      }
      // Lockout expired: reset the counter so a single mistake does not
      // immediately re-lock the account (and cannot be abused as a DoS loop).
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await this.recordFailedLogin(user.id);
      throw new UnauthorizedException('Invalid credentials');
    }

    // 2FA enforced for accounts that have enabled it.
    if (user.twoFactorEnabled || user.twoFactorSecret) {
      if (!twoFactorCode || !this.twoFactor.verify(user.twoFactorSecret!, twoFactorCode)) {
        await this.recordFailedLogin(user.id);
        throw new UnauthorizedException('Two-factor authentication code is required or invalid');
      }
    }

    // Email/SMS login verification: issue a challenge instead of JWTs until
    // the one-time code is confirmed. The password was already validated.
    if (user.loginOtpEnabled) {
      return this.createLoginChallenge(user, ip, userAgent);
    }

    // Success: reset any lockout / failed counter.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    const tokens = await this.issueTokens(user.id, ip, userAgent);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        location: user.location,
        avatarUrl: user.avatarUrl,
        isVerified: user.isVerified,
        isEmailVerified: user.isEmailVerified,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /** Create + deliver a one-time login code. Never returns a JWT. */
  private async createLoginChallenge(
    user: { id: string; email: string; phone: string | null; loginOtpChannel: LoginChannel },
    _ip?: string,
    _userAgent?: string,
  ) {
    const channel = user.loginOtpChannel || LoginChannel.EMAIL;
    const destination = channel === LoginChannel.SMS ? user.phone : user.email;
    if (!destination) {
      throw new BadRequestException(
        channel === LoginChannel.SMS
          ? 'No phone number is configured for SMS verification. Add one in Security.'
          : 'No email is configured for verification.',
      );
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const codeHash = this.hashOtp(code, salt);
    const challenge = await this.prisma.loginChallenge.create({
      data: {
        userId: user.id,
        codeHash,
        salt,
        channel,
        destination,
        expiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MS),
      },
    });

    if (channel === LoginChannel.SMS) {
      await this.sms.sendLoginOtp(destination, code);
    } else {
      await this.mail.sendLoginOtp(destination, code);
    }

    return {
      challenge: true,
      challengeId: challenge.id,
      channel: channel.toLowerCase(),
      destination: this.maskDestination(destination),
      expiresIn: LOGIN_OTP_TTL_MS / 1000,
      // Dev-only, gated by the same flag as password-reset/verification tokens.
      devCode: this.devReturnTokens() ? code : undefined,
    };
  }

  /** Verify a login OTP and only then issue the real token pair. */
  async verifyLoginOtp(challengeId: string, code: string, ip?: string, userAgent?: string) {
    const challenge = await this.prisma.loginChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.usedAt) {
      throw new UnauthorizedException('Invalid or expired login code');
    }
    if (challenge.expiresAt < new Date()) {
      throw new UnauthorizedException('Login code has expired. Request a new one.');
    }
    if (challenge.attempts >= LOGIN_OTP_MAX_ATTEMPTS) {
      throw new UnauthorizedException('Too many attempts. Request a new login code.');
    }
    if (!/^\d{6}$/.test(code) || this.hashOtp(code, challenge.salt) !== challenge.codeHash) {
      await this.prisma.loginChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Incorrect login code');
    }

    await this.prisma.loginChallenge.update({
      where: { id: challenge.id },
      data: { usedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({ where: { id: challenge.userId } });
    if (!user || user.isBanned) throw new UnauthorizedException('Account unavailable');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

    const tokens = await this.issueTokens(user.id, ip, userAgent);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        location: user.location,
        avatarUrl: user.avatarUrl,
        isVerified: user.isVerified,
        isEmailVerified: user.isEmailVerified,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  /** Resend a fresh code for an existing, unused challenge (rate-limited). */
  async resendLoginOtp(challengeId: string) {
    const challenge = await this.prisma.loginChallenge.findUnique({ where: { id: challengeId } });
    if (!challenge || challenge.usedAt) throw new UnauthorizedException('Invalid login challenge');
    if (challenge.expiresAt < new Date()) throw new UnauthorizedException('Login code has expired');
    if (challenge.resends >= LOGIN_OTP_MAX_RESENDS) {
      throw new BadRequestException('Too many resends. Start a new sign-in.');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    await this.prisma.loginChallenge.update({
      where: { id: challenge.id },
      data: {
        codeHash: this.hashOtp(code, salt),
        salt,
        attempts: 0,
        resends: { increment: 1 },
        expiresAt: new Date(Date.now() + LOGIN_OTP_TTL_MS),
      },
    });

    if (challenge.channel === LoginChannel.SMS) {
      await this.sms.sendLoginOtp(challenge.destination, code);
    } else {
      await this.mail.sendLoginOtp(challenge.destination, code);
    }
    return { success: true, expiresIn: LOGIN_OTP_TTL_MS / 1000, devCode: this.devReturnTokens() ? code : undefined };
  }

  /** User-controlled login verification settings. */
  async setLoginOtp(
    userId: string,
    enabled: boolean,
    channel: LoginChannel,
    phone?: string,
  ) {
    if (enabled && channel === LoginChannel.SMS && !phone?.trim()) {
      throw new BadRequestException('A phone number is required for SMS verification');
    }
    const normalizedPhone = phone?.replace(/[^\d+]/g, '') || null;
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        loginOtpEnabled: enabled,
        loginOtpChannel: channel,
        phone: normalizedPhone,
        phoneVerified: false,
      },
      select: {
        loginOtpEnabled: true,
        loginOtpChannel: true,
        phone: true,
        phoneVerified: true,
      },
    });
  }

  private hashOtp(code: string, salt: string): string {
    return createHash('sha256').update(salt + ':' + code).digest('hex');
  }

  private maskDestination(value: string): string {
    if (value.includes('@')) {
      const [name, domain] = value.split('@');
      return `${name.slice(0, 2)}***@${domain}`;
    }
    return this.sms.mask(value);
  }

  /**
   * Social/provider login: find-or-create by provider email, then issue tokens.
   * Provider accounts without a verified email get a scoped `@provider` handle
   * so passwordless users are still uniquely identifiable.
   */
  async loginWithProvider(
    email: string,
    name: string,
    avatarUrl: string | undefined,
    ip?: string,
    userAgent?: string,
  ) {
    const normalized = email.toLowerCase().trim();
    let user = await this.prisma.user.findUnique({ where: { email: normalized } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: normalized,
          name: name || normalized.split('@')[0],
          avatarUrl,
          role: Role.CREATOR,
          isEmailVerified: true,
        },
      });
    }
    if (user.isBanned) {
      throw new ForbiddenException('This account has been suspended');
    }

    const tokens = await this.issueTokens(user.id, ip, userAgent);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        location: user.location,
        avatarUrl: user.avatarUrl,
        isVerified: user.isVerified,
        isEmailVerified: user.isEmailVerified,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  private async recordFailedLogin(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const attempts = user.failedLoginAttempts + 1;
    const data: any = { failedLoginAttempts: attempts };

    if (attempts >= MAX_FAILED_LOGINS) {
      data.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
      data.failedLoginAttempts = 0;
    }
    await this.prisma.user.update({ where: { id: userId }, data });
  }

  private async issueTokens(userId: string, ip?: string, userAgent?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.upsert({
      where: { tokenHash: hashToken(refreshToken) },
      create: {
        tokenHash: hashToken(refreshToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        userAgent: userAgent || null,
        ip: ip || null,
      },
      update: {},
    });

    return { accessToken, refreshToken };
  }

  async refresh(rawToken: string, ip?: string, userAgent?: string) {
    if (!rawToken) throw new UnauthorizedException('Missing refresh token');

    const record = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true },
    });

    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    if (record.user.isBanned) {
      throw new ForbiddenException('This account has been suspended');
    }

    // Rotate: revoke current token and issue a fresh pair.
    const newRefresh = randomBytes(48).toString('hex');
    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: new Date(), replacedBy: hashToken(newRefresh) },
      }),
      this.prisma.refreshToken.create({
        data: {
          tokenHash: hashToken(newRefresh),
          userId: record.userId,
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
          userAgent: userAgent || null,
          ip: ip || null,
        },
      }),
    ]);

    const accessToken = this.jwtService.sign({
      sub: record.user.id,
      email: record.user.email,
      role: record.user.role,
    });

    return { accessToken, refreshToken: newRefresh };
  }

  async logout(rawToken: string) {
    if (!rawToken) return { success: true };
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async logoutAll(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { success: true };
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.passwordHash) throw new BadRequestException('No password set');
    const ok = await bcrypt.compare(current, user.passwordHash);
    if (!ok) throw new ForbiddenException('Current password is incorrect');

    const nextHash = await bcrypt.hash(next, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: nextHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { success: true };
  }

  async requestPasswordReset(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    // Always respond the same to avoid user enumeration.
    if (!user) return { success: true };

    // Invalidate any previous pending resets for this user.
    await this.prisma.passwordReset.updateMany({
      where: { userId: user.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: {
        expiresAt: new Date(0),
        usedAt: new Date(),
      },
    });

    const token = randomBytes(32).toString('hex');
    await this.prisma.passwordReset.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const base = this.config.get('APP_BASE_URL') || 'http://localhost:3000';
    await this.mail.sendPasswordReset(
      user.email,
      `${base}/reset-password?token=${token}`,
    );

    await this.notifications.create({
      userId: user.id,
      type: 'system',
      title: 'Password reset requested',
      body: 'Check your email for a link to reset your password.',
      entityType: 'password_reset',
    });

    // Always respond with the same shape to avoid user enumeration. The raw
    // token is returned only in dev for testability before an SMTP provider
    // is set (never in production, and never the account email itself).
    return {
      success: true,
      ...(this.devReturnTokens() ? { resetToken: token } : {}),
    };
  }

  private devReturnTokens(): boolean {
    return this.config.get('MAIL_DEV_RETURN_TOKENS') === 'true';
  }

  async resetPassword(token: string, newPassword: string) {
    if (!token) throw new BadRequestException('Missing reset token');
    const record = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Reset token is invalid or expired');
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction([
      this.prisma.passwordReset.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      this.prisma.user.update({ where: { id: record.userId }, data: { passwordHash: newHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    return { success: true };
  }

  async verifyEmail(userId: string, token: string) {
    const record = await this.prisma.passwordReset.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record || record.userId !== userId || record.usedAt || record.expiresAt < new Date()) {
      throw new BadRequestException('Verification token is invalid or expired');
    }
    await this.prisma.$transaction([
      this.prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { isEmailVerified: true },
      }),
    ]);
    return { success: true };
  }

  async findById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        twoFactorSecret: true,
        twoFactorEnabled: true,
      },
    });
  }

  async setTwoFactorEnabled(userId: string, secret: string | null, enabled: boolean) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret, twoFactorEnabled: enabled },
    });
  }
}
