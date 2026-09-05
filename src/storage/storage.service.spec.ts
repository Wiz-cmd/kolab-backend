import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand: class {},
  GetObjectCommand: class {},
  DeleteObjectCommand: class {},
}));

describe('StorageService', () => {
  const makeConfig = (values: Record<string, string | undefined>) => ({
    get: jest.fn((key: string) => values[key]),
  });

  it('falls back to local mode when no bucket is configured', async () => {
    const module = await Test.createTestingModule({
      providers: [
        StorageService,
        { provide: ConfigService, useValue: makeConfig({ S3_BUCKET: undefined, UPLOAD_DIR: './uploads' }) },
      ],
    }).compile();
    const svc = module.get(StorageService);
    expect(svc.mode).toBe('local');
  });

  it('uses s3 mode when a bucket is configured', async () => {
    const module = await Test.createTestingModule({
      providers: [
        StorageService,
        {
          provide: ConfigService,
          useValue: makeConfig({
            S3_BUCKET: 'kolab',
            S3_ENDPOINT: 'https://r2',
            S3_ACCESS_KEY_ID: 'a',
            S3_SECRET_ACCESS_KEY: 's',
          }),
        },
      ],
    }).compile();
    const svc = module.get(StorageService);
    expect(svc.mode).toBe('s3');
  });

  it('builds a unique key with a safe server-chosen extension', () => {
    const svc = new StorageService(makeConfig({ UPLOAD_DIR: './uploads' }) as any);
    const k1 = svc.buildKey('image/png');
    const k2 = svc.buildKey('image/png');
    expect(k1.endsWith('.png')).toBe(true);
    expect(k1).not.toBe(k2);
    expect(svc.buildKey('image/jpeg').endsWith('.jpg')).toBe(true);
    expect(svc.buildKey('video/mp4').endsWith('.mp4')).toBe(true);
    // Unknown/misc content gets no scriptable extension.
    expect(svc.buildKey('application/octet-stream')).not.toContain('.');
  });

  it('accepts a real PNG with the matching declared type', async () => {
    const svc = new StorageService(makeConfig({}) as any);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(svc.validateFile({ buffer: png, mimetype: 'image/png' })).toEqual({
      contentType: 'image/png',
      extension: '.png',
    });
  });

  it('rejects content that does not match its declared type', async () => {
    const svc = new StorageService(makeConfig({}) as any);
    // Real PNG bytes claimed as GIF -> must be rejected (magic mismatch).
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(() => svc.validateFile({ buffer: png, mimetype: 'image/gif' })).toThrow(
      'does not match',
    );
  });

  it('rejects an HTML blob masquerading as an image (stored-XSS vector)', async () => {
    const svc = new StorageService(makeConfig({}) as any);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect(() => svc.validateFile({ buffer: html, mimetype: 'image/gif' })).toThrow(
      'Unsupported file type',
    );
    expect(() => svc.validateFile({ buffer: html, mimetype: 'video/mp4' })).toThrow(
      'Unsupported file type',
    );
  });

  it('stores a file locally and returns a static URL in local mode', async () => {
    const svc = new StorageService(
      makeConfig({ S3_BUCKET: undefined, UPLOAD_DIR: './uploads' }) as any,
    );
    const res = await svc.put('abc.png', Buffer.from('data'), 'image/png');
    expect(res.url).toBe('/uploads/abc.png');
    expect(res.key).toBe('abc.png');
    const { writeFile } = require('fs/promises');
    expect(writeFile).toHaveBeenCalled();
  });

  it('returns a relative URL for presigned reads in local mode', async () => {
    const svc = new StorageService(
      makeConfig({ S3_BUCKET: undefined, UPLOAD_DIR: './uploads' }) as any,
    );
    await expect(svc.presignedGet('abc.png')).resolves.toBe('/uploads/abc.png');
  });

  it('passes non-image buffers through unchanged (videos etc.)', async () => {
    const svc = new StorageService(
      makeConfig({ IMAGE_PROCESSING: 'true' }) as any,
    );
    const buf = Buffer.from('le stream');
    const res = await svc.processImage(buf, 'video/mp4');
    expect(res.buffer).toBe(buf); // unchanged reference
    expect(res.contentType).toBe('video/mp4');
  });

  it('skips image processing when disabled', async () => {
    const svc = new StorageService(
      makeConfig({ IMAGE_PROCESSING: 'false' }) as any,
    );
    const buf = Buffer.from('img');
    const res = await svc.processImage(buf, 'image/png');
    expect(res.buffer).toBe(buf);
  });
});
