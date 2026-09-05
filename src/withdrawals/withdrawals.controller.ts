import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsNumber, IsObject, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { Role, WithdrawalStatus } from '@prisma/client';
import { WithdrawalsService } from './withdrawals.service';
import { Roles } from '../common/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class RequestWithdrawalDto {
  @IsNumber()
  @IsPositive()
  @Min(1)
  amount: number;

  @IsString()
  @IsIn(['bank', 'payfast', 'paypal', 'eft'])
  method: string;

  @IsOptional()
  @IsObject()
  details?: Record<string, any>;
}

class ApproveWithdrawalDto {
  @IsOptional()
  @IsString()
  note?: string;
}

class FailWithdrawalDto {
  @IsString()
  reason: string;
}

@Controller('withdrawals')
@UseGuards(JwtAuthGuard)
export class WithdrawalsController {
  constructor(private withdrawals: WithdrawalsService) {}

  @Post()
  request(@CurrentUser('id') userId: string, @Body() dto: RequestWithdrawalDto) {
    return this.withdrawals.request(userId, dto.amount, dto.method, dto.details || {});
  }

  @Get('me')
  mine(@CurrentUser('id') userId: string) {
    return this.withdrawals.listForUser(userId);
  }
}

@Controller('admin/withdrawals')
@UseGuards(JwtAuthGuard)
@Roles(Role.ADMIN)
export class AdminWithdrawalsController {
  constructor(private withdrawals: WithdrawalsService) {}

  @Get()
  list(@Query('status') status?: WithdrawalStatus) {
    return this.withdrawals.listAll(status);
  }

  @Post(':id/approve')
  approve(
    @CurrentUser('id') adminId: string,
    @Body() dto: ApproveWithdrawalDto,
    @Param() params: { id: string },
  ) {
    return this.withdrawals.approve(params.id, adminId, dto.note);
  }

  @Post(':id/paid')
  markPaid(@CurrentUser('id') _adminId: string, @Param() params: { id: string }) {
    return this.withdrawals.markPaid(params.id);
  }

  @Post(':id/fail')
  fail(@Body() dto: FailWithdrawalDto, @Param() params: { id: string }) {
    return this.withdrawals.fail(params.id, dto.reason);
  }
}
