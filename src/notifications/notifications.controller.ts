import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { NotificationsService } from './notifications.service';

class RegisterDeviceDto {
  @IsString()
  token: string;

  @IsIn(['android', 'ios', 'web'])
  platform: 'android' | 'ios' | 'web';
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private notifications: NotificationsService,
    private prisma: PrismaService,
  ) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.notifications.listForUser(userId);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser('id') userId: string) {
    return this.notifications.countUnread(userId);
  }

  @Patch('read-all')
  markAllRead(@CurrentUser('id') userId: string) {
    return this.notifications.markAllRead(userId);
  }

  @Patch(':id/read')
  markRead(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.notifications.markRead(userId, id);
  }

  /** Register an FCM device token for push notifications. */
  @Post('devices')
  registerDevice(@CurrentUser('id') userId: string, @Body() dto: RegisterDeviceDto) {
    return this.prisma.deviceToken.upsert({
      where: { userId_token: { userId, token: dto.token } },
      create: { userId, token: dto.token, platform: dto.platform },
      update: { lastUsedAt: new Date() },
    });
  }

  /** Unregister a device token (e.g. on logout / opt-out). */
  @Delete('devices/:token')
  async removeDevice(@CurrentUser('id') userId: string, @Param('token') token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { success: true };
  }
}
