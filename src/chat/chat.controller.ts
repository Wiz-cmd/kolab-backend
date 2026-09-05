import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class MessageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take = 50;

  @IsOptional()
  @IsString()
  before?: string;
}

@Controller('deals/:dealId/messages')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private chat: ChatService) {}

  @Get()
  history(@CurrentUser('id') userId: string, @Param('dealId') dealId: string, @Query() query: MessageQueryDto) {
    return this.chat.getMessagesForDeal(dealId, userId, { take: query.take, before: query.before });
  }

  @Get('read')
  markRead(@CurrentUser('id') userId: string, @Param('dealId') dealId: string) {
    return this.chat.markDealRead(dealId, userId);
  }
}
