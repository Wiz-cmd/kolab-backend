import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  BadRequestException,
  Get,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { StorageService } from '../storage/storage.service';

const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime'];

// Per-user daily upload cap (availability / storage-exhaustion guard).
const MAX_USER_UPLOAD_BYTES_DAY = 100 * 1024 * 1024; // 100 MB / user / day

@Controller('uploads')
export class UploadsController {
  private readonly uploadsByUser = new Map<string, { bytes: number; day: string }>();

  constructor(
    private config: ConfigService,
    private storage: StorageService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 15 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED.includes(file.mimetype)) {
          return cb(new BadRequestException('Unsupported file type') as any, false);
        }
        cb(null, true);
      },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File, @CurrentUser('id') userId: string) {
    if (!file) throw new BadRequestException('No file uploaded');

    this.enforceDailyQuota(userId, file.size);

    // Verify the real content (magic bytes) matches the declared type, then
    // re-encode images. The stored key uses a server-chosen safe extension, so
    // a malicious file can never be stored/served as scriptable HTML or SVG.
    const detected = this.storage.validateFile(file);
    const processed = await this.storage.processImage(file.buffer, detected.contentType);
    const key = this.storage.buildKey(processed.contentType);
    const { url } = await this.storage.put(key, processed.buffer, processed.contentType);

    return {
      url,
      key,
      filename: key,
      mimetype: processed.contentType,
      size: processed.buffer.length,
      originalSize: file.size,
      storage: this.storage.mode,
      uploadedBy: userId,
    };
  }

  private enforceDailyQuota(userId: string, bytes: number) {
    const day = new Date().toISOString().slice(0, 10);
    const rec = this.uploadsByUser.get(userId);
    const usedToday = rec && rec.day === day ? rec.bytes : 0;
    if (usedToday + bytes > MAX_USER_UPLOAD_BYTES_DAY) {
      throw new BadRequestException('Daily upload limit reached, try again tomorrow');
    }
    this.uploadsByUser.set(userId, { bytes: usedToday + bytes, day });

    // Bounded cleanup so the map never grows without limit.
    if (this.uploadsByUser.size > 10_000) {
      for (const [k, v] of this.uploadsByUser) {
        if (v.day !== day) this.uploadsByUser.delete(k);
      }
    }
  }

  /** Return a short-lived presigned read URL for a private object. */
  @Get('presign')
  @UseGuards(JwtAuthGuard)
  presign(@Query('key') key: string) {
    if (!key) throw new BadRequestException('key required');
    return this.storage.presignedGet(key);
  }
}
