import { Module } from '@nestjs/common';
import { HotspotsService } from './hotspots.service';
import { HotspotsController } from './hotspots.controller';

@Module({
  providers: [HotspotsService],
  controllers: [HotspotsController],
})
export class HotspotsModule {}
