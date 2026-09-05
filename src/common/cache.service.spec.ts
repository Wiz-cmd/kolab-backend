import { CacheService } from './cache.service';

describe('CacheService', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService();
  });

  it('stores and returns cached values', () => {
    cache.set('a', 42, 60_000);
    expect(cache.get('a')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  it('expires entries after their TTL', async () => {
    cache.set('a', 1, 20);
    expect(cache.get('a')).toBe(1);
    await new Promise((r) => setTimeout(r, 40));
    expect(cache.get('a')).toBeUndefined();
  });

  it('wrap loads once and serves subsequent hits from cache', async () => {
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { n: loads };
    };
    const a = await cache.wrap('k', 60_000, loader);
    const b = await cache.wrap('k', 60_000, loader);
    expect(a.n).toBe(1);
    expect(b.n).toBe(1);
    expect(loads).toBe(1);
  });

  it('wrap does not cache loader failures', async () => {
    let loads = 0;
    const failOnce = async () => {
      loads += 1;
      if (loads === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.wrap('k', 60_000, failOnce)).rejects.toThrow('boom');
    expect(await cache.wrap('k', 60_000, failOnce)).toBe('ok');
  });

  it('delPrefix invalidates a whole group', () => {
    cache.set('feed:recent:30', [1], 60_000);
    cache.set('feed:cold:30', [2], 60_000);
    cache.set('hotspots:list:', [3], 60_000);
    cache.delPrefix('feed:');
    expect(cache.get('feed:recent:30')).toBeUndefined();
    expect(cache.get('feed:cold:30')).toBeUndefined();
    expect(cache.get('hotspots:list:')).toEqual([3]);
  });

  it('del removes a single key', () => {
    cache.set('a', 1, 60_000);
    cache.del('a');
    expect(cache.get('a')).toBeUndefined();
  });

  it('stays bounded under MAX_ENTRIES', () => {
    for (let i = 0; i < 10_000; i++) {
      cache.set(`key:${i}`, i, 60_000);
    }
    expect(cache.size).toBeLessThanOrEqual(5_500);
  });
});