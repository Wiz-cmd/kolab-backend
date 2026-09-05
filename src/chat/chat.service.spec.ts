import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatService } from './chat.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ChatService', () => {
  let service: ChatService;
  let prisma: { deal: any; message: any };

  beforeEach(async () => {
    prisma = {
      deal: {
        findUnique: jest.fn(),
      },
      message: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const module = await Test.createTestingModule({
      providers: [ChatService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(ChatService);
  });

  it('throws NotFound for an unknown deal', async () => {
    prisma.deal.findUnique.mockResolvedValue(null);
    await expect(service.assertDealParticipant('d1', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws Forbidden when the sender is not a deal participant', async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: 'd1', brandId: 'u2', creatorId: 'u3' });
    await expect(service.assertDealParticipant('d1', 'u1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('allows a participant to speak', async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: 'd1', brandId: 'u1', creatorId: 'u3' });
    await expect(service.assertDealParticipant('d1', 'u1')).resolves.toBeUndefined();
  });

  it('saves a message for a participant', async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: 'd1', brandId: 'u1', creatorId: 'u3' });
    prisma.message.create.mockResolvedValue({ id: 'm1', senderId: 'u1', content: 'hi', dealId: 'd1' });

    const result = await service.saveMessage('u1', 'hi', 'd1');
    expect(result.id).toBe('m1');
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: { senderId: 'u1', content: 'hi', dealId: 'd1' },
      include: { sender: { select: { id: true, name: true, avatarUrl: true } } },
    });
  });

  it('blocks a non-participant from saving a message', async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: 'd1', brandId: 'u1', creatorId: 'u3' });
    await expect(service.saveMessage('u9', 'hi', 'd1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('marks inbound messages as read', async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: 'd1', brandId: 'u1', creatorId: 'u3' });
    prisma.message.updateMany.mockResolvedValue({ count: 2 });

    const result = await service.markDealRead('d1', 'u3');
    expect(result.updated).toBe(2);
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { dealId: 'd1', senderId: { not: 'u3' }, isRead: false },
      data: { isRead: true, readAt: expect.any(Date) },
    });
  });
});
