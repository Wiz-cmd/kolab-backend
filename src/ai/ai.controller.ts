import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AiService } from './ai.service';

class CaptionDto {
  @IsString()
  @Length(3, 500)
  topic: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  tone?: string;

  @IsOptional()
  @IsString()
  @Length(1, 40)
  platform?: string;
}

class BioDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  niche?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  location?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  keywords?: string;
}

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @ApiOperation({ summary: 'Check whether the free AI assistant is configured' })
  @Get('status')
  status() {
    return this.ai.status();
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate a caption + hashtags for a post' })
  @UseGuards(JwtAuthGuard)
  @Post('caption')
  caption(@Body() dto: CaptionDto) {
    return this.ai.generateCaption(dto);
  }

  @ApiBearerAuth()
  @ApiOperation({ summary: 'Generate a creator profile bio' })
  @UseGuards(JwtAuthGuard)
  @Post('bio')
  bio(@Body() dto: BioDto) {
    return this.ai.generateBio(dto);
  }
}
