import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class CreateUploadDto {
  @ApiProperty({
    description: 'Original filename',
    example: 'my_video.mp4',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 255)
  filename: string;

  @ApiProperty({
    description: 'Declared MIME type (must begin with video/)',
    example: 'video/mp4',
    maxLength: 127,
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 127)
  @Matches(/^video\//, {
    message: 'Only video media types are accepted',
  })
  content_type: string;

  @ApiProperty({
    description: 'File size in bytes (max 10 GB = 10,737,418,240 bytes)',
    example: 52428800,
    minimum: 1,
    maximum: 10737418240,
  })
  @IsInt()
  @Min(1)
  @Max(10737418240)
  size_bytes: number;

  @ApiProperty({
    description:
      'Client file fingerprint for resume matching across network interruptions',
    example: 'fp_my_video.mp4_52428800_1724900000',
    minLength: 1,
    maxLength: 512,
  })
  @IsString()
  @IsNotEmpty()
  @Length(1, 512)
  file_fingerprint: string;
}
