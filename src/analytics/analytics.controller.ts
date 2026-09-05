import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class RecordDto {
  @IsIn(['profile_visit', 'post_view', 'collab_tap', 'impression'])
  type: 'profile_visit' | 'post_view' | 'collab_tap' | 'impression';

  @IsOptional()
  @IsString()
  targetUserId?: string;

  @IsOptional()
  @IsString()
  postId?: string;
}

@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  constructor(
    private analytics: AnalyticsService,
    private prisma: PrismaService,
  ) {}

  /** Record a view/tap against a creator (self as viewer, or anonymous). */
  @ApiOperation({ summary: 'Record a view/tap against a creator' })
  @Post()
  async record(@CurrentUser('id') viewerId: string, @Body() dto: RecordDto) {
    // Resolve which creator the event applies to.
    let targetUserId = dto.targetUserId;
    if (dto.postId) {
      const post = await this.prisma.post.findUnique({ where: { id: dto.postId }, select: { authorId: true } });
      if (!post) return { success: false, error: 'post not found' };
      targetUserId = post.authorId;
    }
    if (!targetUserId) return { success: false, error: 'targetUserId or postId required' };

    await this.analytics.record(targetUserId, {
      type: dto.type,
      postId: dto.postId,
      viewerId,
    });
    return { success: true };
  }

  /** Creator reads their own analytics summary. */
  @ApiOperation({ summary: 'My analytics summary' })
  @Get('me')
  summary(@CurrentUser('id') userId: string, @Query('days') days?: string) {
    const d = days ? Math.max(1, Math.min(365, Number(days) || 30)) : 30;
    return this.analytics.summary(userId, userId, d);
  }
}
