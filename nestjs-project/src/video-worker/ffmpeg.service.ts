import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';

const execFileAsync = promisify(execFile);

export interface VideoProbeResult {
  duration: number;
  width: number;
  height: number;
  codec: string;
  format: string;
  bitrate: number;
  raw: Record<string, unknown>;
}

export interface RenditionConfig {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  bandwidth: number;
}

export const RENDITIONS: Record<string, RenditionConfig> = {
  '360p': {
    name: '360p',
    width: 640,
    height: 360,
    videoBitrate: '800k',
    audioBitrate: '96k',
    bandwidth: 896000,
  },
  '720p': {
    name: '720p',
    width: 1280,
    height: 720,
    videoBitrate: '2500k',
    audioBitrate: '128k',
    bandwidth: 2628000,
  },
  '1080p': {
    name: '1080p',
    width: 1920,
    height: 1080,
    videoBitrate: '5000k',
    audioBitrate: '192k',
    bandwidth: 5192000,
  },
};

@Injectable()
export class FFmpegService {
  private readonly logger = new Logger(FFmpegService.name);

  async probe(filePath: string): Promise<VideoProbeResult> {
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]);

      const data = JSON.parse(stdout) as {
        format?: { duration?: string; format_name?: string; bit_rate?: string };
        streams?: Array<{
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          duration?: string;
        }>;
      };

      const videoStream = data.streams?.find((s) => s.codec_type === 'video');
      const durationStr = data.format?.duration || videoStream?.duration || '0';
      const duration = parseFloat(durationStr);
      const width = videoStream?.width ?? 0;
      const height = videoStream?.height ?? 0;
      const codec = videoStream?.codec_name ?? 'unknown';
      const format = data.format?.format_name ?? 'unknown';
      const bitrate = parseInt(data.format?.bit_rate || '0', 10);

      return {
        duration,
        width,
        height,
        codec,
        format,
        bitrate,
        raw: data as Record<string, unknown>,
      };
    } catch (err: unknown) {
      this.logger.error(
        `ffprobe failed for file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  determineRenditions(sourceHeight: number): RenditionConfig[] {
    const list: RenditionConfig[] = [RENDITIONS['360p']];
    if (sourceHeight >= 480) {
      list.push(RENDITIONS['720p']);
    }
    if (sourceHeight >= 1080) {
      list.push(RENDITIONS['1080p']);
    }
    return list;
  }

  async transcodeHlsRendition(
    sourcePath: string,
    outputDir: string,
    rendition: RenditionConfig,
  ): Promise<void> {
    await fs.mkdir(outputDir, { recursive: true });

    const args = [
      '-y',
      '-i',
      sourcePath,
      '-vf',
      `scale=w=${rendition.width}:h=${rendition.height}:force_original_aspect_ratio=decrease,pad=${rendition.width}:${rendition.height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v',
      'libx264',
      '-crf',
      '22',
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-b:a',
      rendition.audioBitrate,
      '-ac',
      '2',
      '-hls_time',
      '6',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_filename',
      path.join(outputDir, 'segment_%03d.ts'),
      path.join(outputDir, 'playlist.m3u8'),
    ];

    try {
      await execFileAsync('ffmpeg', args);
    } catch (err: unknown) {
      this.logger.error(
        `ffmpeg rendition ${rendition.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  buildMasterPlaylist(renditions: RenditionConfig[]): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const r of renditions) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.width}x${r.height}`,
      );
      lines.push(`${r.name}/playlist.m3u8`);
    }
    return lines.join('\n') + '\n';
  }

  async generateThumbnail(
    sourcePath: string,
    outputPath: string,
    durationSeconds: number,
  ): Promise<void> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const seekTime = Math.min(1.0, Math.max(0, durationSeconds / 2));

    const args = [
      '-y',
      '-ss',
      seekTime.toFixed(3),
      '-i',
      sourcePath,
      '-vframes',
      '1',
      '-q:v',
      '2',
      '-vf',
      'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      outputPath,
    ];

    try {
      await execFileAsync('ffmpeg', args);
    } catch (err: unknown) {
      this.logger.error(
        `ffmpeg thumbnail extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
