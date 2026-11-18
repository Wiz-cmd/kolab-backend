import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SmsService } from './sms.service';

@Module({
  providers: [MailService, SmsService],
  exports: [MailService, SmsService],
})
export class MailModule {}
