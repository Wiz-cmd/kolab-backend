import { Module } from '@nestjs/common';
import { PayoutService } from './payouts.service';

@Module({
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutsModule {}
