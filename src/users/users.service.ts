import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Prisma, Role, VerificationStatus } from '@prisma/client';

@Injectable()
export class UsersService {
  // Fields a visitor may see on any public profile. Everything else
  // (email, balance, 2FA secret, ban/lock state, ID-verification URLs)
  // is withheld from the public `findById` view.
  private readonly publicSelect = {
    id: true,
    name: true,
    role: true,
    location: true,
    avatarUrl: true,
    coverUrl: true,
    bio: true,
    rate: true,
    isVerified: true,
    followersCount: true,
    collabsCount: true,
    measurements: true,
    publicKey: true,
    createdAt: true,
  } as const;

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /** Public profile: a strict allow-list of safe fields only. */
  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...this.publicSelect,
        portfolio: { orderBy: { createdAt: 'desc' }, take: 20 },
        reviewsReceived: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /** Owner-only view (GET /users/me): own profile minus credentials/2FA. */
  async findMe(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        portfolio: { orderBy: { createdAt: 'desc' }, take: 20 },
        reviewsReceived: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    const { passwordHash, twoFactorSecret, ...safe } = user;
    return safe;
  }

  async findMany(filters: {
    role?: Role;
    location?: string;
    search?: string;
    category?: string;
    take?: number;
    skip?: number;
  }) {
    const where: any = { isBanned: false };
    if (filters.role) where.role = filters.role;
    if (filters.location) where.location = { contains: filters.location, mode: 'insensitive' };
    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { bio: { contains: filters.search, mode: 'insensitive' } },
        { location: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        role: true,
        location: true,
        avatarUrl: true,
        bio: true,
        rate: true,
        isVerified: true,
        followersCount: true,
        collabsCount: true,
        measurements: true,
        publicKey: true,
      },
      orderBy: { followersCount: 'desc' },
      skip: filters.skip || 0,
      take: filters.take || 50,
    });
  }

  async updateProfile(userId: string, data: any) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        name: data.name,
        bio: data.bio,
        location: data.location,
        rate: data.rate,
        avatarUrl: data.avatarUrl,
        measurements: data.measurements,
        publicKey: data.publicKey,
      },
      select: {
        id: true, email: true, name: true, role: true, location: true,
        avatarUrl: true, bio: true, rate: true, isVerified: true, measurements: true,
        publicKey: true,
      },
    });
  }

  async addPortfolioItem(userId: string, imageUrl: string, caption?: string) {
    return this.prisma.portfolioItem.create({
      data: { userId, imageUrl, caption },
    });
  }

  /**
   * Account deletion (Google Play requirement + POPIA section 24).
   *
   * Personal content and identifiers are removed or overwritten immediately,
   * and every session is revoked. Deal/review records are retained in
   * anonymised form because they are financial/contractual records; the public
   * profile shows "Deleted user" and cannot be signed into again.
   */
  async deleteMe(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.$transaction([
      this.prisma.portfolioItem.deleteMany({ where: { userId } }),
      this.prisma.portfolioCollection.deleteMany({ where: { userId } }),
      this.prisma.userInterest.deleteMany({ where: { userId } }),
      this.prisma.follow.deleteMany({
        where: { OR: [{ followerId: userId }, { followingId: userId }] },
      }),
      this.prisma.deviceToken.deleteMany({ where: { userId } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.passwordReset.deleteMany({ where: { userId } }),
      this.prisma.notification.deleteMany({ where: { userId } }),
      this.prisma.savedSearch.deleteMany({ where: { userId } }),
      this.prisma.rateCard.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          email: `deleted+${userId}@deleted.kolab.invalid`,
          name: 'Deleted user',
          passwordHash: null,
          bio: null,
          location: null,
          avatarUrl: null,
          coverUrl: null,
          rate: null,
          measurements: Prisma.DbNull,
          isVerified: false,
          isEmailVerified: false,
          isBanned: true,
          bannedAt: new Date(),
          banReason: 'Account deleted by user',
          twoFactorSecret: null,
          twoFactorEnabled: false,
          publicKey: null,
          verificationStatus: VerificationStatus.NONE,
          idUrl: null,
          portfolioProofUrl: null,
          verificationNote: null,
        },
      }),
    ]);

    return { deleted: true };
  }

  async follow(followerId: string, followingId: string) {
    if (followerId === followingId) {
      throw new ConflictException('You cannot follow yourself');
    }
    const target = await this.prisma.user.findUnique({ where: { id: followingId } });
    if (!target) throw new NotFoundException('User not found');

    const existing = await this.prisma.follow.findUnique({
      where: {
        followerId_followingId: { followerId, followingId },
      },
    });

    if (existing) {
      // already following -> return current state
      return { following: true };
    }

    await this.prisma.$transaction([
      this.prisma.follow.create({ data: { followerId, followingId } }),
      this.prisma.user.update({
        where: { id: followingId },
        data: { followersCount: { increment: 1 } },
      }),
    ]);

    await this.notifications.create({
      userId: followingId,
      type: 'follow',
      title: 'New follower',
      entityType: 'user',
    });

    return { following: true };
  }

  async unfollow(followerId: string, followingId: string) {
    const existing = await this.prisma.follow.findUnique({
      where: { followerId_followingId: { followerId, followingId } },
    });
    if (!existing) return { following: false };

    await this.prisma.$transaction([
      this.prisma.follow.delete({ where: { id: existing.id } }),
      this.prisma.user.update({
        where: { id: followingId },
        data: { followersCount: { decrement: 1 } },
      }),
    ]);
    return { following: false };
  }

  async followers(userId: string, opts: { take?: number; skip?: number } = {}) {
    await this.ensureExists(userId);
    return this.prisma.follow.findMany({
      where: { followingId: userId },
      include: {
        follower: {
          select: { id: true, name: true, role: true, avatarUrl: true, location: true },
        },
      },
      skip: opts.skip || 0,
      take: opts.take || 50,
    });
  }

  async following(userId: string, opts: { take?: number; skip?: number } = {}) {
    await this.ensureExists(userId);
    return this.prisma.follow.findMany({
      where: { followerId: userId },
      include: {
        following: {
          select: { id: true, name: true, role: true, avatarUrl: true, location: true },
        },
      },
      skip: opts.skip || 0,
      take: opts.take || 50,
    });
  }

  private async ensureExists(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
  }
}
