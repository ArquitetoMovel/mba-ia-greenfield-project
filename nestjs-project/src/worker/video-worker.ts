import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { VideoWorkerAppModule } from './video-worker-app.module';

export async function bootstrapVideoWorker(): Promise<void> {
  const logger = new Logger('VideoWorkerBootstrap');
  logger.log('Starting Video Worker application context...');
  const app = await NestFactory.createApplicationContext(VideoWorkerAppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });
  app.enableShutdownHooks();
}
