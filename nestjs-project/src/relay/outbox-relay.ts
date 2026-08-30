import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { OutboxRelayAppModule } from './outbox-relay-app.module';
import { OutboxRelayService } from '../outbox/outbox-relay.service';

export async function bootstrapOutboxRelay(): Promise<void> {
  const logger = new Logger('OutboxRelayBootstrap');
  logger.log('Starting Outbox Relay application context...');
  const app = await NestFactory.createApplicationContext(OutboxRelayAppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });
  app.enableShutdownHooks();

  const relayService = app.get(OutboxRelayService);
  await relayService.startRelayLoop();
}
