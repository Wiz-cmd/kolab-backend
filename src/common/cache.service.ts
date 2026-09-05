import { Injectable } from '@nestjs/common';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES = 5_000;

/**
 * Tiny process-local TTL cache for hot read paths (feed candidates, leaderboards,
 * hotspot lists). Bounded size with lazy expiry + periodic sweep. Deliberately
 * single-node: replace with Redis per the deployment runbook when scaling out.
 */
@Injectable()
export class CacheService {
  private readonly store = new Map<string, Entry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number = DEFAULT_TTL_MS): void {
    if (this.store.size >= MAX_ENTRIES) this.sweep();
    if (this.store.size >= MAX_ENTRIES) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Return the cached value or load + cache it (deduplicates concurrent loaders is NOT done — first write wins). */
  async wrap<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await loader();
    this.set(key, value, ttlMs);
    return value;
  }

  del(key: string): void {
    this.store.delete(key);
  }

  /** Expire every key that starts with `prefix` (e.g. invalidate a feed on delete). */
  delPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  /** Drop everything already expired. Cheap, bounded sweep run inside set(). */
  sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }
}