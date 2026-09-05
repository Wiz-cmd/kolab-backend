import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Role } from '@prisma/client';
import { VerificationService } from './verification.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';

class SubmitDto {
  @IsString()
  idUrl: string;

  @IsOptional()
  @IsString()
  proofUrl?: string;
}

@ApiTags('verification')
@Controller('verification')
@UseGuards(JwtAuthGuard)
export class VerificationController {
  constructor(private verification: VerificationService) {}

  @ApiOperation({ summary: 'My verification status' })
  @Get('me')
  myStatus(@CurrentUser('id') userId: string) {
    return this.verification.myStatus(userId);
  }

  @ApiOperation({ summary: 'Submit ID + portfolio proof for the badge' })
  @Post()
  submit(@CurrentUser('id') userId: string, @Body() dto: SubmitDto) {
    return this.verification.submit(userId, dto);
  }
}

@ApiTags('verification')
@ApiBearerAuth()
@Controller('admin/verification')
@UseGuards(JwtAuthGuard)
@Roles(Role.ADMIN)
export class AdminVerificationController {
  constructor(private verification: VerificationService) {}

  @ApiOperation({ summary: 'List pending verification requests' })
  @Get('pending')
  pending() {
    return this.verification.listPending();
  }

  @ApiOperation({ summary: 'Approve a verification request' })
  @Post(':id/approve')
  approve(@Param('id') id: string, @CurrentUser('id') adminId: string, @Body('note') note?: string) {
    return this.verification.approve(id, adminId, note);
  }

  @ApiOperation({ summary: 'Reject a verification request' })
  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentUser('id') adminId: string, @Body('note') note: string) {
    return this.verification.reject(id, adminId, note);
  }
}
