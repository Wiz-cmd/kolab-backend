import { BadRequestException, Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationService } from '../moderation/moderation.service';
import { AlertsService } from '../alerts/alerts.service';
import { CacheService } from '../common/cache.service';

/**
 * Recommendation weights (similar to social "For You" feeds)
 * - Interest match: user has liked this category/role/location before
 * - Recency: newer posts rank higher
 * - Engagement: posts with more likes get a boost
 * - Author affinity: posts from roles the user engages with
 * - Exploration: small random boost so new categories still surface
 */
const W = {
  categoryInterest: 4.0,
  tagInterest: 2.5,
  roleInterest: 3.0,
  locationInterest: 2.0,
  followingAuthor: 5.0,
  likesLog: 1.2,
  recencyHours: 48,
  recencyBoost: 3.0,
  exploration: 0.8,
};

const POST_AUTHOR_SELECT = {
  id: true,
  name: true,
  avatarUrl: true,
  role: true,
  location: true,
} as const;

const POST_INCLUDE = {
  author: { select: POST_AUTHOR_SELECT },
  _count: { select: { comments: true } },
} as const;

@Injectable()
export class PostsService {
  constructor(
    private prisma: PrismaService,
    private readonly moderation: ModerationService,
    private readonly alerts: AlertsService,
    private readonly cache: CacheService,
  ) {}

  async create(
    userId: string,
    data: {
      description: string;
      location?: string;
      imageUrl?: string;
      videoUrl?: string;
      filter?: string;
      isStudioOrGear?: boolean;
      hotspotId?: string;
      category?: string;
      tags?: string[];
    },
  ) {
    const post = await this.prisma.post.create({
      data: {
        authorId: userId,
        description: data.description,
        location: data.location,
        imageUrl: data.imageUrl,
        videoUrl: data.videoUrl,
        filter: data.filter,
        isStudioOrGear: data.isStudioOrGear || false,
        hotspotId: data.hotspotId,
        category: (data.category || 'general').toLowerCase(),
        tags: (data.tags || []).map((t) => t.toLowerCase()),
      },
      include: POST_INCLUDE,
    });

    // Content moderation auto-flag (fire-and-forget, never blocks publishing).
    this.moderation
      .reviewNewPost(post.id, data.description, post.category)
      .catch(() => null);

    // Saved-search alerts ("notify me when a model in CPT posts").
    this.alerts
      .matchAndNotify(post.author, { id: post.id, category: post.category, tags: post.tags })
      .catch(() => null);

    return this.decorate(post);
  }

  /**
   * Chronological feed (fallback / following-style). Supports the search
   * algorithm filters: free-text `search`, `category`, and comma-separated
   * `tags`. Filtered queries skip the cache so results are always fresh.
   */
  async findFeed(
    limit = 30,
    skip = 0,
    filters: { search?: string; category?: string; tags?: string } = {},
  ) {
    const where: Record<string, any> = {};

    if (filters.category) {
      where.category = filters.category.toLowerCase();
    }

    if (filters.tags) {
      const tags = filters.tags
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      if (tags.length > 0) {
        where.tags = { hasSome: tags };
      }
    }

    if (filters.search) {
      const q = filters.search.trim().toLowerCase();
      if (q) {
        where.OR = [
          { description: { contains: q } },
          { category: { contains: q } },
          { tags: { hasSome: [q] } },
          { location: { contains: q } },
          {
            author: {
              name: { contains: q },
            },
          },
        ];
      }
    }

    const find = async () => {
      const posts = await this.prisma.post.findMany({
        where,
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
        include: POST_INCLUDE,
      });
      return posts.map((post) => this.decorate(post));
    };

    // Unfiltered feed keeps its short cache; search queries skip it.
    if (Object.keys(where).length === 0) {
      return this.cache.wrap(`feed:recent:${limit}:${skip}`, 10_000, find);
    }
    return find();
  }

  async deletePost(postId: string, userId: string, role: string) {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post) throw new NotFoundException('Post not found');
    if (post.authorId !== userId && role !== 'ADMIN') {
      throw new ForbiddenException('Only the author (or admin) can delete this post');
    }
    await this.prisma.post.delete({ where: { id: postId } });
    this.cache.delPrefix('feed:');
    return { success: true };
  }

  /** Edit the caption/metadata of an existing Frame (author or admin only). */
  async updatePost(
    postId: string,
    userId: string,
    role: string,
    data: {
      description?: string;
      location?: string;
      filter?: string;
      isStudioOrGear?: boolean;
      category?: string;
      tags?: string[];
    },
  ) {
    const existing = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!existing) throw new NotFoundException('Post not found');
    if (existing.authorId !== userId && role !== 'ADMIN') {
      throw new ForbiddenException('Only the author (or admin) can edit this post');
    }

    const update: Record<string, any> = {};
    if (data.description !== undefined) update.description = data.description.trim();
    if (data.location !== undefined) update.location = data.location;
    if (data.filter !== undefined) update.filter = data.filter;
    if (data.isStudioOrGear !== undefined) update.isStudioOrGear = data.isStudioOrGear;
    if (data.category !== undefined) update.category = data.category.toLowerCase();
    if (data.tags !== undefined) update.tags = data.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);

    const post = await this.prisma.post.update({
      where: { id: postId },
      data: update,
      include: POST_INCLUDE,
    });
    this.cache.delPrefix('feed:');
    return this.decorate(post);
  }

  /**
   * Personalized "For You" feed.
   * Ranks posts by what the user has liked / engaged with before.
   */
  async findForYouFeed(userId: string | null, limit = 30) {
    // Cold start: no user → popular + recent mix
    if (!userId) {
      return this.coldStartFeed(limit);
    }

    const [interests, following, recentPosts] = await Promise.all([
      this.prisma.userInterest.findMany({ where: { userId } }),
      this.prisma.follow.findMany({
        where: { followerId: userId },
        select: { followingId: true },
      }),
      // Candidate pool is shared across users, so cache it briefly. No per-post
      // COUNT sub-query: `likesCount` is maintained by toggleLike().
      this.cache.wrap('feed:pool', 10_000, () =>
        this.prisma.post.findMany({
          take: 150, // candidate pool
          orderBy: { createdAt: 'desc' },
          include: POST_INCLUDE,
        }),
      ),
    ]);

    const interestMap = new Map(interests.map((i) => [i.key, i.score]));
    const followingSet = new Set(following.map((f) => f.followingId));
    const now = Date.now();

    const scored = recentPosts.map((post) => {
      let score = 0;

      // Category interest
      const catScore = interestMap.get(`category:${post.category}`) || 0;
      score += catScore * W.categoryInterest;

      // Tag interests
      for (const tag of post.tags || []) {
        const t = interestMap.get(`tag:${tag}`) || 0;
        score += t * W.tagInterest;
      }

      // Author role interest (MODEL, PHOTOGRAPHER, etc.)
      if (post.author?.role) {
        const roleScore = interestMap.get(`role:${post.author.role}`) || 0;
        score += roleScore * W.roleInterest;
      }

      // Location interest
      if (post.location) {
        const locKey = post.location.toLowerCase().split(',')[0].trim();
        const locScore = interestMap.get(`location:${locKey}`) || 0;
        score += locScore * W.locationInterest;
      }

      // Following boost
      if (followingSet.has(post.authorId)) {
        score += W.followingAuthor;
      }

      // Engagement (log scale so viral posts don't dominate forever)
      const likes = post.likesCount || 0;
      score += Math.log10(likes + 1) * W.likesLog;

      // Recency (stronger in first ~48h)
      const ageHours = (now - new Date(post.createdAt).getTime()) / (1000 * 60 * 60);
      const recency = Math.max(0, 1 - ageHours / W.recencyHours);
      score += recency * W.recencyBoost;

      // Light exploration so users discover new niches
      score += Math.random() * W.exploration;

      return { post, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => this.decorate(s.post));
  }

  private async coldStartFeed(limit: number) {
    // Mix of most liked recent posts (public path - cached briefly).
    return this.cache.wrap(`feed:cold:${limit}`, 20_000, async () => {
      const posts = await this.prisma.post.findMany({
        take: limit,
        orderBy: [{ likesCount: 'desc' }, { createdAt: 'desc' }],
        include: POST_INCLUDE,
      });
      return posts.map((post) => this.decorate(post));
    });
  }

  /** Adds `commentsCount` next to Prisma's relation count. */
  private decorate<T extends { _count?: { comments: number } }>(post: T) {
    const { _count, ...rest } = post as any;
    return { ...rest, commentsCount: _count?.comments ?? 0 };
  }

  async toggleLike(userId: string, postId: string) {
    const existing = await this.prisma.like.findUnique({
      where: { userId_postId: { userId, postId } },
    });

    if (existing) {
      await this.prisma.like.delete({ where: { id: existing.id } });
      const updated = await this.prisma.post.update({
        where: { id: postId },
        data: { likesCount: { decrement: 1 } },
        select: { likesCount: true },
      });
      this.cache.delPrefix('feed:');
      // Soft decay interest (optional: skip for simplicity)
      return { liked: false, likesCount: updated.likesCount };
    }

    await this.prisma.like.create({ data: { userId, postId } });
    const updated = await this.prisma.post.update({
      where: { id: postId },
      data: { likesCount: { increment: 1 } },
      select: { likesCount: true },
    });

    // Record engagement + strengthen interests from this post
    await this.recordEngagement(userId, postId, 'like');
    await this.boostInterestsFromPost(userId, postId, 1.0);
    this.cache.delPrefix('feed:');

    return { liked: true, likesCount: updated.likesCount };
  }

  /** Call when user views a post (feed impression / open). Guests count too. */
  async recordView(userId: string | null, postId: string) {
    await this.prisma.post.update({
      where: { id: postId },
      data: { viewsCount: { increment: 1 } },
    });
    if (!userId) return { ok: true };
    await this.recordEngagement(userId, postId, 'view');
    // Weaker signal than like
    await this.boostInterestsFromPost(userId, postId, 0.15);
    return { ok: true };
  }

  /** Call when user taps Collab on a post */
  async recordCollabTap(userId: string, postId: string) {
    await this.recordEngagement(userId, postId, 'collab_tap');
    await this.boostInterestsFromPost(userId, postId, 1.5);
    return { ok: true };
  }

  private async recordEngagement(userId: string, postId: string, type: string) {
    try {
      await this.prisma.engagement.create({
        data: { userId, postId, type },
      });
    } catch {
      // non-critical
    }
  }

  private async boostInterestsFromPost(userId: string, postId: string, amount: number) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: { author: { select: { role: true, location: true } } },
    });
    if (!post) return;

    const keys: string[] = [`category:${post.category}`];
    for (const tag of post.tags || []) {
      keys.push(`tag:${tag}`);
    }
    if (post.author?.role) keys.push(`role:${post.author.role}`);
    if (post.location) {
      keys.push(`location:${post.location.toLowerCase().split(',')[0].trim()}`);
    }
    if (post.author?.location) {
      keys.push(`location:${post.author.location.toLowerCase().split(',')[0].trim()}`);
    }

    for (const key of keys) {
      await this.prisma.userInterest.upsert({
        where: { userId_key: { userId, key } },
        create: { userId, key, score: amount },
        update: { score: { increment: amount } },
      });
    }
  }

  async getUserInterests(userId: string) {
    return this.prisma.userInterest.findMany({
      where: { userId },
      orderBy: { score: 'desc' },
      take: 30,
    });
  }

  // ── Frames comments ────────────────────────────────────────────────

  async listComments(postId: string, limit = 50, skip = 0) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found');

    const [data, total] = await this.prisma.$transaction([
      this.prisma.comment.findMany({
        where: { postId },
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
        include: { author: { select: POST_AUTHOR_SELECT } },
      }),
      this.prisma.comment.count({ where: { postId } }),
    ]);

    return { data, total, take: limit, skip };
  }

  async createComment(userId: string, postId: string, content: string) {
    const text = content.trim();
    if (!text) throw new BadRequestException('Comment cannot be empty');

    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('Post not found');

    const comment = await this.prisma.comment.create({
      data: { postId, authorId: userId, content: text },
      include: { author: { select: POST_AUTHOR_SELECT } },
    });

    // Comment count is part of every feed payload.
    this.cache.delPrefix('feed:');
    return comment;
  }

  async deleteComment(commentId: string, userId: string, role: string) {
    const comment = await this.prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, authorId: true, postId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.authorId !== userId && role !== 'ADMIN') {
      throw new ForbiddenException('Only the author (or admin) can delete this comment');
    }

    await this.prisma.comment.delete({ where: { id: commentId } });
    this.cache.delPrefix('feed:');
    return { success: true, postId: comment.postId };
  }
}
