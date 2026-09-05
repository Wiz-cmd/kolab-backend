import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CommonModule } from './common/common.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PostsModule } from './posts/posts.module';
import { HotspotsModule } from './hotspots/hotspots.module';
import { DealsModule } from './deals/deals.module';
import { ChatModule } from './chat/chat.module';
import { UploadsModule } from './uploads/uploads.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PaymentsModule } from './payments/payments.module';
import { AdminModule } from './admin/admin.module';
import { ReportsModule } from './reports/reports.module';
import { MailModule } from './mail/mail.module';
import { WithdrawalsModule } from './withdrawals/withdrawals.module';
import { ContractsModule } from './contracts/contracts.module';
import { JobsModule } from './jobs/jobs.module';
import { PayoutsModule } from './payouts/payouts.module';
import { VerificationModule } from './verification/verification.module';
import { AlertsModule } from './alerts/alerts.module';
import { PricingModule } from './pricing/pricing.module';
import { CollectionsModule } from './collections/collections.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { ModerationModule } from './moderation/moderation.module';
import { SocialModule } from './social/social.module';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { SecurityHeadersMiddleware } from './common/security-headers.middleware';
import { RateLimitMiddleware } from './common/rate-limit.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Stage-aware config: loads .env, then .env.<NODE_ENV> overrides on top.
      envFilePath: ['.env', `.env.${process.env.NODE_ENV || 'development'}`, '.env.local'],
    }),
    CommonModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    PostsModule,
    HotspotsModule,
    DealsModule,
    ChatModule,
    UploadsModule,
    NotificationsModule,
    PaymentsModule,
    AdminModule,
    ReportsModule,
    MailModule,
    WithdrawalsModule,
    ContractsModule,
    JobsModule,
    PayoutsModule,
    VerificationModule,
    AlertsModule,
    PricingModule,
    CollectionsModule,
    AnalyticsModule,
    ModerationModule,
    SocialModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestContextMiddleware, SecurityHeadersMiddleware, RateLimitMiddleware)
      .forRoutes('*');
  }
}
