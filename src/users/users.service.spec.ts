import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';

function makePrisma() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({ id: 'u1' }),
    },
    portfolioItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    portfolioCollection: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    userInterest: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    follow: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    deviceToken: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    passwordReset: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    notification: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    savedSearch: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    rateCard: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  prisma.$transaction = jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));
  return prisma;
}

describe('UsersService.deleteMe', () => {
  it('throws when the account does not exist', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue(null);
    const service = new UsersService(prisma, {} as any);

    await expect(service.deleteMe('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes personal data and anonymises the account', async () => {
    const prisma = makePrisma();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'me@example.com' });
    const service = new UsersService(prisma, {} as any);

    await expect(service.deleteMe('u1')).resolves.toEqual({ deleted: true });

    expect(prisma.portfolioItem.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.portfolioCollection.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(prisma.follow.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ followerId: 'u1' }, { followingId: 'u1' }] },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'u1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });

    const update = prisma.user.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'u1' });
    expect(update.data).toMatchObject({
      email: 'deleted+u1@deleted.kolab.invalid',
      name: 'Deleted user',
      passwordHash: null,
      bio: null,
      location: null,
      avatarUrl: null,
      coverUrl: null,
      rate: null,
      isBanned: true,
      isEmailVerified: false,
      twoFactorEnabled: false,
      publicKey: null,
      idUrl: null,
      portfolioProofUrl: null,
    });
  });
});
