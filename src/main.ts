import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { AppModule } from './app.module';
import { AppLogger } from './common/logger.service';
import { corsOriginOption, corsIsWildcard } from './common/cors-origins';
import { join } from 'path';

async function bootstrap() {
  const structured = (process.env.LOG_STRUCTURED || 'true') === 'true';
  const logger = new AppLogger('Bootstrap', structured);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: structured ? ['log', 'error', 'warn', 'debug', 'verbose'] : undefined,
  });
  const config = app.get(ConfigService);

  // Locked-origin CORS from config. `*` is only honoured without credentials:
  // reflecting every origin while also allowing credentials would let any site
  // initiate authenticated/credential-carrying requests against the API.
  const wildcard = corsIsWildcard();
  app.enableCors({
    origin: corsOriginOption(),
    credentials: !wildcard,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  // gzip JSON/HTML responses (images are already compressed and are skipped).
  app.use(compression({ threshold: 1024, level: 6 }));

  // Cap parser sizes so a single oversized JSON/urlencoded body can't exhaust
  // memory. Multipart uploads have their own explicit limit in the controller.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });

  // Trust proxy hops (e.g. TRUST_PROXY=1 behind nginx/traefik/ALB) so
  // `req.ip` is the caller's real address for accurate per-IP rate limiting.
  const trustProxy = Number(config.get('TRUST_PROXY') || 0);
  if (trustProxy > 0) app.set('trust proxy', trustProxy);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      forbidNonWhitelisted: true,
    }),
  );

  app.setGlobalPrefix('api');
  app.disable('x-powered-by');

  // OpenAPI / Swagger docs. HTTP surface is best kept closed in production:
  // enabled explicitly via SWAGGER_ENABLED=true, or by default outside prod.
  const env = config.get('NODE_ENV') || 'development';
  const swaggerSetting = config.get('SWAGGER_ENABLED');
  const swaggerEnabled =
    swaggerSetting === 'true' || (swaggerSetting == null && env !== 'production');

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Kolab API')
      .setDescription('Kolab – South African creator & model platform backend.')
      .setVersion('1.2.0')
      .addBearerAuth()
      .addTag('auth', 'Authentication & account security')
      .addTag('users', 'Profiles, follows & portfolios')
      .addTag('posts', 'Feed posts, likes & the For You recommender')
      .addTag('deals', 'Deals, escrow, disputes & release')
      .addTag('payments', 'PayFast & Ozow')
      .addTag('notifications', 'In-app + push notifications')
      .addTag('admin', 'Moderation & operations')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
    logger.log('Swagger available at /api/docs');
  }

  const uploadDir = config.get('UPLOAD_DIR') || './uploads';
  const prod = (config.get('NODE_ENV') || 'development') === 'production';
  app.useStaticAssets(join(process.cwd(), uploadDir), {
    prefix: '/uploads/',
    index: false,
    fallthrough: false,
    maxAge: prod ? '1d' : 0,
    immutable: false,
  });

  // Graceful shutdown so in-flight DB writes finish on SIGTERM.
  app.enableShutdownHooks();

  const port = config.get('PORT') || 3000;
  const server = await app.listen(port);

  // Slowloris / hang protection + fast connection reuse for the HTTP server.
  server.setTimeout(30_000); // active request cap
  server.requestTimeout = 30_000; // time to receive the full request (Node >= 18)
  server.headersTimeout = 31_000; // must exceed keepAliveTimeout
  server.keepAliveTimeout = 5_000;

  logger.log(`Kolab backend running on http://localhost:${port} (prefix /api)`);
}
bootstrap();
