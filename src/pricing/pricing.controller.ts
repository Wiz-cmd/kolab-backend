import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PricingService } from './pricing.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class CreateRateCardDto {
  @IsString()
  title: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsString()
  includes?: string;
}

class UpdateRateCardDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) price?: number;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsString() includes?: string;
  @IsOptional() @IsString() active?: string; // "true"/"false"
}

@ApiTags('pricing')
@ApiBearerAuth()
@Controller('rate-cards')
@UseGuards(JwtAuthGuard)
export class PricingController {
  constructor(private pricing: PricingService) {}

  @ApiOperation({ summary: 'List my rate cards & packages' })
  @Get()
  list(@CurrentUser('id') userId: string, @Query('activeOnly') activeOnly?: string) {
    return this.pricing.listForUser(userId, activeOnly === 'true');
  }

  @ApiOperation({ summary: 'Create a rate card / package' })
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateRateCardDto) {
    return this.pricing.create(userId, dto);
  }

  @ApiOperation({ summary: 'Update a rate card' })
  @Patch(':id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateRateCardDto) {
    return this.pricing.update(userId, id, {
      title: dto.title,
      price: dto.price,
      unit: dto.unit,
      includes: dto.includes,
      ...(dto.active !== undefined ? { active: dto.active === 'true' } : {}),
    });
  }

  @ApiOperation({ summary: 'Delete a rate card' })
  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.pricing.remove(userId, id);
  }
}
