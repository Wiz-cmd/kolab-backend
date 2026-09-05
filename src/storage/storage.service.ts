import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

export type StorageMode = 's3' | 'local';
export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mp4',
};

/** True when the buffer starts with one of the standard MP4/MOV box atoms. */
function hasIsoBmffBox(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const window = Math.min(buf.length - 4, 4096);
  for (let off = 4; off < window; off += 4) {
    const tag = buf.toString('latin1', off, off + 4);
    if (tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'moof' || tag === 'styp') {
      return true;
    }
  }
  return false;
}

// Content sniffers keyed on real file magic bytes, not the client-supplied
// mimetype (which is trivially spoofable).
const MAGIC_DETECTORS: ReadonlyArray<{
  contentTypes: ReadonlyArray<string>;
  matches: (b: Buffer) => boolean;
}> = [
  {
    contentTypes: ['image/jpeg'],
    matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    contentTypes: ['image/png'],
    matches: (b) =>
      b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a,
  },
  {
    contentTypes: ['image/gif'],
    matches: (b) => {
      const sig = b.length >= 6 ? b.toString('latin1', 0, 6) : '';
      return sig === 'GIF87a' || sig === 'GIF89a';
    },
  },
  {
    contentTypes: ['image/webp'],
    matches: (b) =>
      b.length >= 12 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP',
  },
  {
    contentTypes: ['video/mp4', 'video/quicktime'],
    matches: hasIsoBmffBox,
  },
];

/**
 * Object-storage abstraction. Defaults to S3-compatible API which also works
 * with Cloudflare R2 (just point `S3_ENDPOINT` at your R2 endpoint and use
 * R2 access key/secret).
 *
 * When `S3_BUCKET` is not configured, the service transparently falls back to
 * "local" mode (files stored under UPLOAD_DIR and served statically), so
 * development works without any cloud credentials.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private client: S3Client | null = null;
  private readonly bucket: string | null;

  constructor(private config: ConfigService) {
    this.bucket = this.config.get('S3_BUCKET') || null;

    if (this.bucket) {
      const endpoint = this.config.get('S3_ENDPOINT');
      const region = this.config.get('S3_REGION') || 'auto';
      this.client = new S3Client({
        region,
        endpoint: endpoint || undefined,
        forcePathStyle: endpoint ? true : undefined,
        credentials: {
          accessKeyId: this.config.get('S3_ACCESS_KEY_ID') || '',
          secretAccessKey: this.config.get('S3_SECRET_ACCESS_KEY') || '',
        },
      });
      this.logger.log(`Storage initialised for bucket "${this.bucket}" (S3/R2-compatible).`);
    } else {
      this.logger.warn(
        'S3_BUCKET not configured - using LOCAL storage. Set S3_* env vars for production.',
      );
    }
  }

  get mode(): StorageMode {
    return this.client ? 's3' : 'local';
  }

  /** Store a binary buffer (or stream) and return its public key/URL. */
  async put(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    contentType: string,
  ): Promise<{ key: string; url: string }> {
    if (!this.client) {
      // Local fallback: write to disk under UPLOAD_DIR.
      return this.putLocal(key, body, contentType);
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket!,
        Key: key,
        Body: body as any,
        ContentType: contentType,
      }),
    );

    return { key, url: this.publicUrl(key) };
  }

  /** Generate a time-limited URL for private/secure reads. */
  async presignedGet(key: string, expiresInSeconds = 3600): Promise<string> {
    if (!this.client) {
      return `/uploads/${key}`;
    }
    const command = new GetObjectCommand({ Bucket: this.bucket!, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async delete(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket!, Key: key }),
    );
  }

  /**
   * A stable unique key for an uploaded file. The extension is derived from the
   * (validated/processed) content type — never from the client's filename — so
   * uploads can never be stored and served as HTML, SVG, or other scriptable
   * content on our origin.
   */
  buildKey(contentType: string): string {
    const ext = EXT_BY_TYPE[contentType] || '';
    return `${Date.now()}-${randomUUID()}${ext}`;
  }

  /**
   * Verify a candidate upload against real content (magic bytes).
   * Returns a normalized content type + safe extension, or throws when the
   * bytes do not match the declared mimetype (or are not a supported file).
   */
  validateFile(file: { buffer: Buffer; mimetype: string }): { contentType: string; extension: string } {
    for (const detector of MAGIC_DETECTORS) {
      if (detector.matches(file.buffer)) {
        if (!detector.contentTypes.includes(file.mimetype)) {
          throw new BadRequestException('File content does not match its declared type');
        }
        const contentType = detector.contentTypes[0];
        return { contentType, extension: EXT_BY_TYPE[contentType] || '.bin' };
      }
    }
    throw new BadRequestException('Unsupported file type');
  }

  /**
   * Optionally resize/compress an image with sharp before storage. When sharp is
   * unavailable, unconfigured, or the input is not an image, the buffer is
   * returned unchanged.
   */
  async processImage(
    buffer: Buffer,
    contentType: string,
    opts: { maxWidth?: number; maxHeight?: number; quality?: number } = {},
  ): Promise<ProcessedImage> {
    const isImage = /^image\/(jpeg|png|webp|gif)$/i.test(contentType);
    if (!isImage) return { buffer, contentType };
    if (this.config.get('IMAGE_PROCESSING') !== 'true') {
      return { buffer, contentType };
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      const normalized = contentType === 'image/jpeg' ? 'jpeg' : 'webp';
      const outFormat = this.config.get('IMAGE_OUTPUT_FORMAT') || normalized;

      const metadata = await sharp(buffer).metadata();
      const maxWidth =
        opts.maxWidth || Number(this.config.get('IMAGE_MAX_WIDTH') || 2048);
      const maxHeight =
        opts.maxHeight || Number(this.config.get('IMAGE_MAX_HEIGHT') || 2048);

      let pipeline = sharp(buffer).rotate();
      if (metadata.width! > maxWidth || metadata.height! > maxHeight) {
        pipeline = pipeline.resize({
          width: maxWidth,
          height: maxHeight,
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
      pipeline =
        outFormat === 'jpeg'
          ? pipeline.jpeg({ quality: opts.quality || Number(this.config.get('IMAGE_QUALITY') || 82) })
          : pipeline.webp({ quality: opts.quality || Number(this.config.get('IMAGE_QUALITY') || 80) });

      const outBuffer = await pipeline.toBuffer();
      const outContentType = outFormat === 'jpeg' ? 'image/jpeg' : 'image/webp';
      this.logger.log(
        `Processed image: ${buffer.length} -> ${outBuffer.length} bytes (${contentType} -> ${outContentType})`,
      );
      return { buffer: outBuffer, contentType: outContentType };
    } catch (e: any) {
      this.logger.warn(`Image processing skipped: ${e.message}`);
      return { buffer, contentType };
    }
  }

  private publicUrl(key: string): string {
    const base = this.config.get('S3_PUBLIC_BASE_URL');
    const cdn = this.config.get('S3_CDN_BASE_URL');
    const host = cdn || base || this.bucket!;
    return `${host}/${key}`;
  }

  private async putLocal(
    key: string,
    body: Buffer | NodeJS.ReadableStream,
    _contentType: string,
  ): Promise<{ key: string; url: string }> {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const dir = this.config.get('UPLOAD_DIR') || './uploads';
    await writeFile(join(process.cwd(), dir, key), body as any);
    return { key, url: `/uploads/${key}` };
  }
}
