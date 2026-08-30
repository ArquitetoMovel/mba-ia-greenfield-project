import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { VideoWorkerModule } from './video-worker.module';
import { VideoProcessorService } from './video-processor.service';
import { FFmpegService } from './ffmpeg.service';
import { Video } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from '../outbox/outbox.types';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  OutboxEvent,
];

describe('VideoWorkerModule', () => {
  it('compiles and provides VideoProcessorService and FFmpegService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoWorkerModule,
      ],
    })
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue({ add: jest.fn() })
      .compile();

    expect(module.get(VideoProcessorService)).toBeDefined();
    expect(module.get(FFmpegService)).toBeDefined();
    await module.close();
  });
});
