import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DealStatus } from '@prisma/client';
import { ContractsService } from './contracts.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';

const configMock = { get: jest.fn((k: string) => (k === 'APP_NAME' ? 'Kolab' : undefined)) };

describe('ContractsService', () => {
  let service: ContractsService;
  let prisma: any;
  const storage = { put: jest.fn() };
  const notifications = { create: jest.fn().mockResolvedValue(null) };

  const deal = {
    id: 'd1',
    brandId: 'b1',
    creatorId: 'c1',
    title: 'Lookbook shoot',
    amount: 1000,
    platformFee: 200,
    creatorAmount: 800,
    status: DealStatus.COMPLETED,
    deliverables: '10 edited photos',
    deadline: null,
    brand: { id: 'b1', name: 'Acme', email: 'acme@x.co' },
    creator: { id: 'c1', name: 'Thandi', email: 'thandi@x.co' },
  };

  beforeEach(async () => {
    storage.put.mockResolvedValue({ key: 'contracts/d1-1.pdf', url: 'https://cdn/d1.pdf' });
    prisma = {
      deal: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      contract: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
    };
    prisma.contract.upsert.mockResolvedValue({ id: 'con1', dealId: 'd1', html: '', contractUrl: 'https://cdn/d1.pdf' });

    const module = await Test.createTestingModule({
      providers: [
        ContractsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: ConfigService, useValue: configMock },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(ContractsService);
  });

  it('throws NotFound for an unknown deal', async () => {
    prisma.deal.findUnique.mockResolvedValue(null);
    await expect(service.generateContract('nope', 'b1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws BadRequest for a non-participant', async () => {
    prisma.deal.findUnique.mockResolvedValue(deal);
    await expect(service.generateContract('d1', 'stranger')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('throws when the deal is not contractable (e.g. CANCELLED)', async () => {
    prisma.deal.findUnique.mockResolvedValue({ ...deal, status: 'CANCELLED' });
    await expect(service.generateContract('d1', 'b1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('generates, stores and upserts a contract record', async () => {
    prisma.deal.findUnique.mockResolvedValue(deal);

    const result = await service.generateContract('d1', 'b1');

    await expect(storage.put).toHaveBeenCalledWith(
      expect.stringContaining('contracts/'),
      expect.any(Buffer),
      'application/pdf',
    );
    expect(prisma.contract.upsert).toHaveBeenCalled();
    expect(prisma.deal.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ contractUrl: 'https://cdn/d1.pdf' }) }),
    );
    expect(notifications.create).toHaveBeenCalled();
    expect(result.contractUrl).toBe('https://cdn/d1.pdf');
  });
});
