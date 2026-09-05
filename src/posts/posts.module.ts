import { Module } from '@nestjs/common';
import { PostsService } from './posts.service';
import { PostsController } from './posts.controller';
import { ModerationModule } from '../moderation/moderation.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [ModerationModule, AlertsModule],
  providers: [PostsService],
  controllers: [PostsController],
  exports: [PostsService],
})
export class PostsModule {}
