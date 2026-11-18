import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostsService } from './posts.service';

type MockPrisma = {
  post: {
    create: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
  comment: {
    create: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
  };
  engagement: { create: jest.Mock };
  userInterest: { upsert: jest.Mock };
  $transaction: jest.Mock;
};

function makeService() {
  const prisma: MockPrisma = {
    post: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    comment: {
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
    engagement: { create: jest.fn() },
    userInterest: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const moderation = { reviewNewPost: jest.fn().mockResolvedValue(undefined) };
  const alerts = { matchAndNotify: jest.fn().mockResolvedValue(undefined) };
  const cache = { delPrefix: jest.fn(), wrap: jest.fn(), del: jest.fn() };
  const service = new PostsService(
    prisma as any,
    moderation as any,
    alerts as any,
    cache as any,
  );
  return { service, prisma, moderation, alerts, cache };
}

const postRow = {
  id: 'post-1',
  authorId: 'user-1',
  description: 'A Frame',
  category: 'general',
  tags: [],
  filter: 'golden',
  imageUrl: 'https://example.com/a.jpg',
  videoUrl: null,
  viewsCount: 0,
  likesCount: 0,
  author: { id: 'user-1', name: 'A', avatarUrl: null, role: 'MODEL', location: null },
  _count: { comments: 0 },
};

describe('PostsService Frames', () => {
  it('stores the selected look when publishing and returns a comment count', async () => {
    const { service, prisma } = makeService();
    prisma.post.create.mockResolvedValue(postRow);

    const result = await service.create('user-1', {
      description: 'A Frame',
      imageUrl: 'https://example.com/a.jpg',
      filter: 'golden',
    });

    expect(prisma.post.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ filter: 'golden' }),
      }),
    );
    expect(result).toMatchObject({ id: 'post-1', commentsCount: 0, filter: 'golden' });
  });

  it('lists comments newest first and returns the total', async () => {
    const { service, prisma } = makeService();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1' });
    const comments = [{ id: 'c1', content: 'Nice' }];
    prisma.comment.findMany.mockResolvedValue(comments);
    prisma.comment.count.mockResolvedValue(1);
    prisma.$transaction.mockResolvedValue([comments, 1]);

    const result = await service.listComments('post-1', 50, 0);

    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, take: 50, skip: 0 }),
    );
    expect(result).toEqual({ data: comments, total: 1, take: 50, skip: 0 });
  });

  it('rejects comments on a missing Frame', async () => {
    const { service, prisma } = makeService();
    prisma.post.findUnique.mockResolvedValue(null);

    await expect(service.createComment('user-1', 'missing', 'Hi')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates a comment and invalidates cached feeds', async () => {
    const { service, prisma, cache } = makeService();
    prisma.post.findUnique.mockResolvedValue({ id: 'post-1' });
    prisma.comment.create.mockResolvedValue({
      id: 'c1',
      postId: 'post-1',
      content: 'Nice',
      author: postRow.author,
    });

    const result = await service.createComment('user-1', 'post-1', '  Nice  ');

    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { postId: 'post-1', authorId: 'user-1', content: 'Nice' },
      }),
    );
    expect(cache.delPrefix).toHaveBeenCalledWith('feed:');
    expect(result.id).toBe('c1');
  });

  it('only lets the author or an admin delete a comment', async () => {
    const { service, prisma } = makeService();
    prisma.comment.findUnique.mockResolvedValue({
      id: 'c1',
      authorId: 'user-1',
      postId: 'post-1',
    });

    await expect(service.deleteComment('c1', 'user-2', 'USER')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.comment.delete).not.toHaveBeenCalled();

    prisma.comment.delete.mockResolvedValue({});
    await expect(service.deleteComment('c1', 'admin-1', 'ADMIN')).resolves.toEqual({
      success: true,
      postId: 'post-1',
    });
  });

  it('counts guest views without recording a user engagement', async () => {
    const { service, prisma } = makeService();
    prisma.post.update.mockResolvedValue({});

    await expect(service.recordView(null, 'post-1')).resolves.toEqual({ ok: true });

    expect(prisma.post.update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { viewsCount: { increment: 1 } },
    });
    expect(prisma.engagement.create).not.toHaveBeenCalled();
  });

  it('lets the author edit a Frame and invalidates cached feeds', async () => {
    const { service, prisma, cache } = makeService();
    prisma.post.findUnique.mockResolvedValue(postRow);
    prisma.post.update.mockResolvedValue(postRow);

    const result = await service.updatePost('post-1', 'user-1', 'CREATOR', {
      description: '  Updated caption  ',
      tags: ['Studio', ' frames '],
      category: 'LIFESTYLE',
    });

    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'Updated caption',
          category: 'lifestyle',
          tags: ['studio', 'frames'],
        }),
      }),
    );
    expect(cache.delPrefix).toHaveBeenCalledWith('feed:');
    expect(result).toMatchObject({ id: 'post-1' });
  });

  it('rejects editing someone else\'s Frame', async () => {
    const { service, prisma } = makeService();
    prisma.post.findUnique.mockResolvedValue(postRow);

    await expect(
      service.updatePost('post-1', 'user-2', 'CREATOR', { description: 'hack' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.post.update).not.toHaveBeenCalled();
  });
});
