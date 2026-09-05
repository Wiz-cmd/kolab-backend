import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { IsString } from 'class-validator';
import { Request } from 'express';
import { SocialService } from './social.service';

class ExchangeDto {
  @IsString()
  code: string;

  @IsString()
  state: string;
}

@Controller('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  /** Build the OAuth authorize URL. Returns { configured:false } when the
   *  provider has no credentials — the app shows the "not configured" state. */
  @Get(':provider/start')
  start(@Param('provider') provider: string) {
    return this.social.start(provider);
  }

  /** Exchange the auth code the deep link carried. Issue JWTs on success. */
  @Post(':provider/exchange')
  exchange(
    @Param('provider') provider: string,
    @Body() dto: ExchangeDto,
    @Req() req: Request,
  ) {
    return this.social.exchange(
      provider,
      dto.code,
      dto.state,
      req.ip,
      req.get('User-Agent'),
    );
  }
}