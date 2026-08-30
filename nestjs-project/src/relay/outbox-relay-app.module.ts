import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import { OutboxModule } from '../outbox/outbox.module';
import { OutboxEvent } from '../videos/entities/outbox-event.entity';
import { Video } from '../videos/entities/video.entity';
import { UploadSession } from '../videos/entities/upload-session.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (db: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: db.host,
        port: db.port,
        username: db.username,
        password: db.password,
        database: db.name,
        entities: [
          OutboxEvent,
          Video,
          UploadSession,
          Channel,
          User,
          RefreshToken,
          VerificationToken,
        ],
        synchronize: false,
      }),
    }),
    OutboxModule,
  ],
})
export class OutboxRelayAppModule {}
