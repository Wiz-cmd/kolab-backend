import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { ModerationService } from './moderation.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';

@ApiTags('moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(JwtAuthGuard)
@Roles(Role.ADMIN)
export class ModerationController {
  constructor(private moderation: ModerationService) {}

  @ApiOperation({ summary: 'List the content moderation queue' })
  @Get()
  queue(@Query('status') status?: string) {
    return this.moderation.listQueue(
      ['IN_REVIEW', 'APPROVED', 'FLAGGED', 'REMOVED'].includes(status || '')
        ? (status as any)
        : undefined,
    );
  }

  @ApiOperation({ summary: 'Approve or remove a queued submission' })
  @Post(':id/:action')
  review(
    @Param('id') id: string,
    @Param('action') action: 'approve' | 'remove',
    @CurrentUser('id') adminId: string,
  ) {
    return this.moderation.review(id, adminId, action);
  }
}
