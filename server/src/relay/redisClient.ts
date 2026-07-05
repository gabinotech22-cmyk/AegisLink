import Redis from 'ioredis';


const REDIS_URL = process.env.REDIS_URL;

export const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

if (redis) {
  redis.on('error', (err) => {
    console.error('Redis connection error', { error: err instanceof Error ? err.message : String(err) });
  });
  redis.on('connect', () => {
    console.log('Connected to Redis for rate limiting');
  });
} else {
  console.log('No REDIS_URL found. Using fallback in-memory rate limiting.');
}
