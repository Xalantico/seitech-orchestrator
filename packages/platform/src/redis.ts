import { Redis } from "ioredis";

export { Redis };

export function createRedis(url: string | undefined): Redis | null {
  if (!url) return null;
  return new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
}

/** Fixed-window limiter. Redis when available (shared across replicas), memory otherwise. */
export function createRateLimiter(redis: Redis | null) {
  const memory = new Map<string, { count: number; resetAt: number }>();
  return async function hit(key: string, limit: number, windowSec: number): Promise<{ allowed: boolean; remaining: number; resetSec: number }> {
    if (redis) {
      const bucket = `rl:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
      const count = await redis.incr(bucket);
      if (count === 1) await redis.expire(bucket, windowSec);
      return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetSec: windowSec };
    }
    const now = Date.now();
    const entry = memory.get(key);
    if (!entry || entry.resetAt <= now) {
      memory.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      if (memory.size > 50_000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
      return { allowed: true, remaining: limit - 1, resetSec: windowSec };
    }
    entry.count += 1;
    return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetSec: Math.ceil((entry.resetAt - now) / 1000) };
  };
}
