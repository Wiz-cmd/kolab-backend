import { Module } from '@nestjs/common';
import { DealsService } from './deals.service';
import { AdminDealsController, DealsController } from './deals.controller';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  providers: [DealsService],
  controllers: [DealsController, AdminDealsController],
  exports: [DealsService],
})
export class DealsModule {}
