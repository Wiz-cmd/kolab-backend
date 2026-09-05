import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { ReportsService } from './reports.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class ReportUserDto {
  @IsString()
  @MinLength(1)
  reason: string;
}

class ReportPostDto {
  @IsString()
  @MinLength(1)
  reason: string;
}

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private reports: ReportsService) {}

  @Post('user/:id')
  reportUser(@CurrentUser('id') me: string, @Param('id') id: string, @Body() dto: ReportUserDto) {
    return this.reports.reportUser(me, id, dto.reason);
  }

  @Post('post/:id')
  reportPost(@CurrentUser('id') me: string, @Param('id') id: string, @Body() dto: ReportPostDto) {
    return this.reports.reportPost(me, id, dto.reason);
  }

  @Get('me')
  myReports(@CurrentUser('id') me: string) {
    return this.reports.myReports(me);
  }
}
