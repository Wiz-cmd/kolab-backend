import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { AlertsService } from './alerts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class CreateSearchDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsObject()
  filters: Record<string, any>;
}

class SetActiveDto {
  @IsBoolean()
  active: boolean;
}

@ApiTags('alerts')
@ApiBearerAuth()
@Controller('searches')
@UseGuards(JwtAuthGuard)
export class AlertsController {
  constructor(private alerts: AlertsService) {}

  @ApiOperation({ summary: 'Save a search / create an alert' })
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSearchDto) {
    return this.alerts.create(userId, dto);
  }

  @ApiOperation({ summary: 'List my saved searches' })
  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.alerts.listForUser(userId);
  }

  @ApiOperation({ summary: 'Enable/disable a saved search' })
  @Patch(':id')
  setActive(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SetActiveDto) {
    return this.alerts.setActive(userId, id, dto.active);
  }

  @ApiOperation({ summary: 'Delete a saved search' })
  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.alerts.remove(userId, id);
  }
}
