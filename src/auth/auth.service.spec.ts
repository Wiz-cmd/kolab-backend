import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../mail/sms.service';
import { TwoFactorService } from './two-factor.service';

jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed'),
  compare: jest.fn(),
}));

const configMock = {
  get: jest.fn((key: string) => {
    const map: Record<string, string> = {
      JWT_SECRET: 'secret',
      APP_BASE_URL: 'http://localhost:3000',
      MAIL_DEV_RETURN_TOKENS: 'true',
    };
    return map[key];
  }),
};

describe('AuthService', () => {
  let service: AuthService;
  let prisma: { user: any; refreshToken: any; passwordReset: any; loginChallenge: any; $transaction: any };
  let jwt: { sign: any };

  const baseUser = {
    id: 'u1',
    email: 'a@b.co',
    passwordHash: 'hashed',
    name: 'A',
    role: Role.CREATOR,
    location: 'JHB',
    avatarUrl: null,
    isVerified: false,
    isEmailVerified: false,
    isBanned: false,
    balance: 0,
    failedLoginAttempts: 0,
    lockedUntil: null,
  };

  beforeEach(async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);

    prisma = {
      user: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          // issueTokens + login reload by id/email
          return where && (where.id === 'u1' || where.email === 'a@b.co')
            ? { ...baseUser }
            : { ...baseUser };
        }),
        create: jest.fn().mockResolvedValue({ ...baseUser }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      refreshToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      passwordReset: {
        create: jest.fn().mockResolvedValue({ id: 'pr1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      loginChallenge: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: 'lc1', ...data })),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (ops: any[]) => {
        for (const op of ops) await op;
        return ops;
      }),
    };

    jwt = { sign: jest.fn(() => 'access-token') };
    const notifications = { create: jest.fn().mockResolvedValue(null) };
    const mail = {
      sendPasswordReset: jest.fn().mockResolvedValue({ delivered: false }),
      sendEmailVerification: jest.fn().mockResolvedValue({ delivered: false }),
      sendLoginOtp: jest.fn().mockResolvedValue({ delivered: false }),
    };
    const sms = {
      mask: jest.fn((v: string) => '***'),
      sendLoginOtp: jest.fn().mockResolvedValue({ delivered: false }),
    };
    const twoFactor = { verify: jest.fn().mockReturnValue(true) };

    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: configMock },
        { provide: NotificationsService, useValue: notifications },
        { provide: MailService, useValue: mail },
        { provide: SmsService, useValue: sms },
        { provide: TwoFactorService, useValue: twoFactor },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  it('registers a new user and returns tokens', async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }) =>
      where.email === 'a@b.co' ? null : { ...baseUser },
    );

    const result = await service.register({
      email: 'a@b.co',
      password: 'password123',
      name: 'A',
    });

    expect(result.accessToken).toBe('access-token');
    expect(prisma.passwordReset.create).toHaveBeenCalled(); // verification token created
  });

  it('rejects duplicate registration', async () => {
    prisma.user.findUnique.mockImplementation(async () => ({ ...baseUser }));
    await expect(
      service.register({ email: 'a@b.co', password: 'password123', name: 'A' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never mints an ADMIN account from the public registration payload', async () => {
    prisma.user.findUnique.mockImplementation(async ({ where }) =>
      where.email === 'admin@x.co' ? null : { ...baseUser },
    );
    prisma.user.create.mockImplementation(async ({ data }) => ({
      ...baseUser,
      role: data.role as Role,
    }));

    await service.register({
      email: 'admin@x.co',
      password: 'password123',
      name: 'X',
      role: Role.ADMIN,
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: Role.CREATOR }),
      }),
    );
  });

  it('rejects a banned user at login', async () => {
    prisma.user.findUnique.mockImplementation(async () => ({ ...baseUser, isBanned: true }));
    await expect(service.login('a@b.co', 'whatever')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects login while account is locked', async () => {
    prisma.user.findUnique.mockImplementation(async () => ({
      ...baseUser,
      lockedUntil: new Date(Date.now() + 60_000),
    }));
    await expect(service.login('a@b.co', 'password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a wrong password and records the failed attempt', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    prisma.user.findUnique.mockResolvedValue({ ...baseUser });

    await expect(service.login('a@b.co', 'wrong')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedLoginAttempts: 1 }) }),
    );
  });

  it('logs in successfully with valid credentials', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...baseUser });
    prisma.refreshToken.upsert.mockResolvedValue({});

    const result: any = await service.login('a@b.co', 'password');
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBeDefined();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedLoginAttempts: 0 }) }),
    );
  });

  it('rejects an invalid refresh token on rotation', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    await expect(service.refresh('bad-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rotates refresh tokens and revokes the old one', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt1',
      tokenHash: 'h',
      userId: 'u1',
      expiresAt: new Date(Date.now() + 1000),
      revokedAt: null,
      user: { ...baseUser },
    });

    const result = await service.refresh('valid-token');
    expect(result.accessToken).toBe('access-token');
    expect(result.refreshToken).toBeDefined();
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('returns an OTP challenge instead of tokens when login verification is enabled', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...baseUser, loginOtpEnabled: true, loginOtpChannel: 'EMAIL' });
    const result: any = await service.login('a@b.co', 'password123');
    expect(result.challenge).toBe(true);
    expect(result.accessToken).toBeUndefined();
    expect(result.challengeId).toBe('lc1');
    expect(result.devCode).toMatch(/^\d{6}$/);
    expect(prisma.loginChallenge.create).toHaveBeenCalled();
  });

  it('issues tokens only after the correct login OTP', async () => {
    const code = '123456';
    const salt = 'salt';
    prisma.loginChallenge.findUnique.mockResolvedValue({
      id: 'lc1',
      userId: 'u1',
      codeHash: (service as any).hashOtp(code, salt),
      salt,
      channel: 'EMAIL',
      destination: 'a@b.co',
      attempts: 0,
      resends: 0,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    const result = await service.verifyLoginOtp('lc1', code);
    expect(result.accessToken).toBe('access-token');
    expect(prisma.loginChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ usedAt: expect.any(Date) }) }),
    );
  });

  it('rejects a wrong login OTP and records the attempt', async () => {
    prisma.loginChallenge.findUnique.mockResolvedValue({
      id: 'lc1',
      userId: 'u1',
      codeHash: (service as any).hashOtp('111111', 'salt'),
      salt: 'salt',
      channel: 'EMAIL',
      destination: 'a@b.co',
      attempts: 0,
      resends: 0,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    });
    await expect(service.verifyLoginOtp('lc1', '222222')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.loginChallenge.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: { increment: 1 } } }),
    );
  });

  it('rejects password reset with a used token', async () => {
    prisma.passwordReset.findUnique.mockResolvedValue({
      id: 'pr1',
      tokenHash: 'h',
      userId: 'u1',
      usedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });
    await expect(service.resetPassword('token', 'newpass123')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
