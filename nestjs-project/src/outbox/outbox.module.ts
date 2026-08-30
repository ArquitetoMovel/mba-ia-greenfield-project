import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { OutboxRelayService } from './outbox-relay.service';
import { VIDEO_PROCESSING_QUEUE } from './outbox.types';

@Module({
  imports: [
    ConfigModule.forFeature(queueConfig),
    TypeOrmModule.forFeature([OutboxEvent]),
    BullModule.forRootAsync({
      imports: [ConfigModule.forFeature(queueConfig)],
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.host,
          port: cfg.port,
        },
      }),
    }),
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
    }),
  ],
  providers: [OutboxRelayService],
  exports: [OutboxRelayService, BullModule],
})
export class OutboxModule {}
