import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';
import { AdminService } from './admin.service';
import { Roles } from '../common/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

export class BanUserDto {
  @IsString()
  @MinLength(1)
  reason: string;
}

export class AdjustBalanceDto {
  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ResolveReportDto {
  @IsString()
  @MinLength(1)
  resolution: string;

  @IsOptional()
  @IsIn(['dismiss', 'warn', 'ban'])
  action?: 'dismiss' | 'warn' | 'ban';
}

@Controller('admin')
@UseGuards(JwtAuthGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(private admin: AdminService) {}

  @Post('users/:id/ban')
  ban(@CurrentUser('id') adminId: string, @Param('id') id: string, @Body() dto: BanUserDto) {
    return this.admin.banUser(adminId, id, dto.reason);
  }

  @Post('users/:id/unban')
  unban(@Param('id') id: string) {
    return this.admin.unbanUser(id);
  }

  @Post('posts/:id/delete')
  deletePost(@Param('id') id: string, @Body() body: { note?: string }) {
    return this.admin.deletePost(id, body.note);
  }

  @Post('users/:id/balance')
  adjustBalance(@Param('id') id: string, @Body() dto: AdjustBalanceDto) {
    return this.admin.adjustBalance(id, dto.amount, dto.reason);
  }

  @Patch('reports/:id/resolve')
  resolveReport(@Param('id') id: string, @Body() dto: ResolveReportDto) {
    return this.admin.resolveReport(id, dto.resolution, dto.action);
  }

  @Get('disputes')
  disputes(@Query() query: PaginationQueryDto) {
    return this.admin.listDisputes({ take: query.take, skip: query.skip });
  }
}
