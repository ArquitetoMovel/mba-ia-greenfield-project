import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { OutboxModule } from './outbox.module';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { Video } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { VIDEO_PROCESSING_QUEUE } from './outbox.types';
import queueConfig from '../config/queue.config';

const ALL_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
  UploadSession,
  OutboxEvent,
];

describe('OutboxModule', () => {
  it('compiles and provides OutboxRelayService and video-processing Queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        OutboxModule,
      ],
    })
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue({ add: jest.fn() })
      .compile();

    expect(module.get(OutboxRelayService)).toBeDefined();
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    await module.close();
  });
});
