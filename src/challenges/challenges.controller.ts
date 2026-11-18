import { Controller, Get, Query } from '@nestjs/common';
import { ChallengesService } from './challenges.service';

@Controller('challenges')
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @Get('current')
  current() {
    return this.challenges.current();
  }

  @Get('current/leaderboard')
  leaderboard(@Query('limit') limit?: string) {
    return this.challenges.leaderboard(Math.min(100, Math.max(1, Number(limit) || 20)));
  }
}
