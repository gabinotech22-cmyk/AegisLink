import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL;

export const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

if (redis) {
  redis.on('error', (err) => {
    console.error('[Redis] Connection error:', err);
  });
  redis.on('connect', () => {
    console.log('[Redis] Connected to Redis for rate limiting');
  });
} else {
  console.log('[Redis] No REDIS_URL found. Using fallback in-memory rate limiting.');
}
