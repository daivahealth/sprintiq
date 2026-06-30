import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppRole, roleServesHttp } from './config/app-role';

async function bootstrap() {
  // rawBody:true exposes req.rawBody so collector webhook receivers can verify
  // per-provider signatures over the exact bytes received (BC-1).
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const role = config.get<AppRole>('appRole') ?? AppRole.API;
  const port = config.get<number>('port') ?? 3000;

  app.use(helmet());
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Application API is namespaced under /api; collector webhook receivers stay
  // at /webhooks/* (public, per-provider signature-verified — see BC-1 / api docs).
  app.setGlobalPrefix('api', {
    exclude: ['health', 'webhooks/(.*)'],
  });

  await app.listen(port);

  logger.log(`SprintIQ backend started — role="${role}", port=${port}`);
  if (role === AppRole.COLLECTOR) {
    logger.log('Collector role: webhook receivers active at /webhooks/*');
  } else if (role === AppRole.WORKER) {
    logger.log(
      'Worker role: scheduled pollers / rollups / rules / agents active',
    );
  } else if (roleServesHttp(role)) {
    logger.log('API role: dashboard BFF + admin + auth active at /api/*');
  }
}

void bootstrap();
