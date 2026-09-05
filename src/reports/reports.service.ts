import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async reportUser(reporterId: string, reportedUserId: string, reason: string) {
    const target = await this.prisma.user.findUnique({ where: { id: reportedUserId } });
    if (!target) throw new NotFoundException('User not found');
    return this.prisma.report.create({
      data: { reporterId, reportedUserId, reason },
    });
  }

  async reportPost(reporterId: string, reportedPostId: string, reason: string) {
    const post = await this.prisma.post.findUnique({ where: { id: reportedPostId } });
    if (!post) throw new NotFoundException('Post not found');
    return this.prisma.report.create({
      data: { reporterId, reportedPostId, reason, createdById: post.authorId },
    });
  }

  async myReports(userId: string) {
    return this.prisma.report.findMany({
      where: { reporterId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
}
