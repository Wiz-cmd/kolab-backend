import { Module } from '@nestjs/common';
import { VerificationService } from './verification.service';
import { VerificationController, AdminVerificationController } from './verification.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [VerificationController, AdminVerificationController],
  providers: [VerificationService],
  exports: [VerificationService],
})
export class VerificationModule {}
