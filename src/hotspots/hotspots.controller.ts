import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { HotspotsService } from './hotspots.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { CreateHotspotDto, HotspotQueryDto } from './dto/hotspots.dto';

@Controller('hotspots')
export class HotspotsController {
  constructor(private hotspotsService: HotspotsService) {}

  @Get()
  findAll(@Query() query: HotspotQueryDto) {
    return this.hotspotsService.findAll({
      province: query.province,
      category: query.category,
      city: query.city,
      skip: query.skip,
      take: query.take,
    });
  }

  @Get('leaderboard')
  leaderboard(@Query('month') month?: string) {
    return this.hotspotsService.getLeaderboard(month);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateHotspotDto) {
    return this.hotspotsService.create(userId, dto);
  }

  @Post(':id/checkin')
  @UseGuards(JwtAuthGuard)
  checkIn(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.hotspotsService.checkIn(userId, id);
  }
}
