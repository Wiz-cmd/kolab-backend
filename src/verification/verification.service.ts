import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Role, VerificationStatus } from '@prisma/client';

/**
 * Verified-badge workflow. Creators submit an ID + portfolio proof; an admin
 * reviews and either approves (badge granted) or rejects.
 */
@Injectable()
export class VerificationService {
  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
  ) {}

  /** Creator submits proof -> creates a PENDING verification and flags the user. */
  async submit(userId: string, dto: { idUrl: string; proofUrl?: string }) {
    if (!dto.idUrl) throw new BadRequestException('ID proof is required');

    const existing = await this.prisma.verification.findFirst({
      where: { userId, status: VerificationStatus.PENDING },
    });
    const data = {
      userId,
      idUrl: dto.idUrl,
      proofUrl: dto.proofUrl || null,
      status: VerificationStatus.PENDING,
    };

    const verification = existing
      ? await this.prisma.verification.update({ where: { id: existing.id }, data })
      : await this.prisma.verification.create({ data });

    await this.prisma.user.update({
      where: { id: userId },
      data: { verificationStatus: VerificationStatus.PENDING },
    });

    return verification;
  }

  /** Admin approves -> badge granted, mirror on User + Notification. */
  async approve(verificationId: string, adminId: string, note?: string) {
    const v = await this.prisma.verification.findUnique({ where: { id: verificationId } });
    if (!v) throw new NotFoundException('Verification not found');

    await this.prisma.$transaction([
      this.prisma.verification.update({
        where: { id: verificationId },
        data: { status: VerificationStatus.APPROVED, reviewedBy: adminId, reviewedAt: new Date(), note },
      }),
      this.prisma.user.update({
        where: { id: v.userId },
        data: { verificationStatus: VerificationStatus.APPROVED, verifiedAt: new Date() },
      }),
    ]);

    await this.notifications.create({
      userId: v.userId,
      type: 'system',
      title: 'You are verified!',
      body: 'Your profile now shows the verified badge.',
      entityType: 'verification',
      entityId: verificationId,
    });

    return { success: true };
  }

  /** Admin rejects -> badge denied, allow re-submission. */
  async reject(verificationId: string, adminId: string, note: string) {
    const v = await this.prisma.verification.findUnique({ where: { id: verificationId } });
    if (!v) throw new NotFoundException('Verification not found');

    await this.prisma.$transaction([
      this.prisma.verification.update({
        where: { id: verificationId },
        data: { status: VerificationStatus.REJECTED, reviewedBy: adminId, reviewedAt: new Date(), note },
      }),
      this.prisma.user.update({
        where: { id: v.userId },
        data: { verificationStatus: VerificationStatus.REJECTED, verificationNote: note },
      }),
    ]);

    await this.notifications.create({
      userId: v.userId,
      type: 'system',
      title: 'Verification update',
      body: `Your verification request was declined: ${note || 'No reason given'}`,
      entityType: 'verification',
      entityId: verificationId,
    });

    return { success: true };
  }

  async listPending() {
    return this.prisma.verification.findMany({
      where: { status: VerificationStatus.PENDING },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, name: true, email: true, location: true } } },
    });
  }

  async myStatus(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      status: u?.verificationStatus || VerificationStatus.NONE,
      verified: u?.verificationStatus === VerificationStatus.APPROVED,
      note: u?.verificationNote || null,
    };
  }
}
