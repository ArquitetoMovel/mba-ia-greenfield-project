import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { VIDEO_PROCESSING_QUEUE } from '../outbox/outbox.types';
import { FFmpegService } from './ffmpeg.service';
import { VideoProcessorService } from './video-processor.service';

@Module({
  imports: [
    ConfigModule.forFeature(queueConfig),
    TypeOrmModule.forFeature([Video, UploadSession, OutboxEvent]),
    StorageModule,
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
  providers: [FFmpegService, VideoProcessorService],
  exports: [VideoProcessorService, BullModule],
})
export class VideoWorkerModule {}
