import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class CompletedPartItemDto {
  @ApiProperty({
    description: '1-indexed part number',
    example: 1,
    minimum: 1,
    maximum: 10000,
  })
  @IsInt()
  @Min(1)
  @Max(10000)
  part_number: number;

  @ApiProperty({
    description: 'ETag returned by S3/MinIO for the uploaded part',
    example: 'd41d8cd98f00b204e9800998ecf8427e',
  })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    description: 'Ordered array of completed parts',
    type: [CompletedPartItemDto],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CompletedPartItemDto)
  parts: CompletedPartItemDto[];
}
