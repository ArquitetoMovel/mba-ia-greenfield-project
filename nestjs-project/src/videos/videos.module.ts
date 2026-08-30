import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { UploadSession } from './entities/upload-session.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { VideosController } from './videos.controller';
import { UploadSessionsService } from './upload-sessions.service';
import { MediaDeliveryService } from './media-delivery.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, UploadSession, OutboxEvent]),
    ChannelsModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [UploadSessionsService, MediaDeliveryService],
  exports: [TypeOrmModule, UploadSessionsService, MediaDeliveryService],
})
export class VideosModule {}
