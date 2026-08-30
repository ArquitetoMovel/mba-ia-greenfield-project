import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { S3MediaStorageService } from './s3-media-storage.service';

describe('StorageModule', () => {
  it('should compile with S3MediaStorageService and storageConfig', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    const service = module.get<S3MediaStorageService>(S3MediaStorageService);
    expect(service).toBeDefined();
    await module.close();
  });
});
