import { Test } from '@nestjs/testing';
import { ModerationService } from './moderation.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ModerationService', () => {
  let service: ModerationService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      publication: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [ModerationService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ModerationService);
  });

  it('scores clean content low and auto-approves', async () => {
    const { status, score } = await service.reviewNewPost('p1', 'Beautiful editorial shoot', 'beauty');
    expect(score).toBeLessThan(0.15);
    expect(status).toBe('APPROVED');
    expect(prisma.publication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ postId: 'p1', status: 'APPROVED' }),
    });
  });

  it('auto-flags content with blocked terms', async () => {
    const { status, score } = await service.reviewNewPost('p2', 'stuff about buy-followers links www.spam.com', 'general');
    expect(score).toBeGreaterThanOrEqual(0.5);
    expect(status).toBe('FLAGGED');
  });

  it('queues borderline content for review', async () => {
    const { status } = await service.reviewNewPost('p3', 'check out https://example.com', 'general');
    expect(status).toBe('IN_REVIEW');
  });

  it('lists the moderation queue', async () => {
    prisma.publication.findMany.mockResolvedValue([]);
    await service.listQueue('FLAGGED');
    expect(prisma.publication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'FLAGGED' } }),
    );
  });

  it('marks a submission approved or removed', async () => {
    prisma.publication.findUnique.mockResolvedValue({ id: 'q1', postId: 'p1' });
    prisma.publication.update.mockResolvedValue({});

    await service.review('q1', 'admin1', 'remove');
    expect(prisma.publication.update).toHaveBeenCalledWith({
      where: { id: 'q1' },
      data: expect.objectContaining({ status: 'REMOVED', reviewedBy: 'admin1' }),
    });
  });
});
