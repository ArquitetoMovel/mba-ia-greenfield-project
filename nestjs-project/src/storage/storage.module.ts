import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3MediaStorageService } from './s3-media-storage.service';

@Module({
  imports: [ConfigModule.forFeature(storageConfig)],
  providers: [S3MediaStorageService],
  exports: [S3MediaStorageService],
})
export class StorageModule {}
