import Redis from 'ioredis';
import { logger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL;

export const redis = REDIS_URL ? new Redis(REDIS_URL, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    if (times > 5) {
      return null;
    }
    return Math.min(times * 100, 3000);
  }
}) : null;

if (redis) {
  redis.on('error', (err) => {
    // Never log the raw error object — it may embed the connection string
    // (host/port/auth) from ioredis internals. Only the message/code.
    const e = err as NodeJS.ErrnoException;
    logger.error('Redis connection error', { message: e.message, code: e.code ?? '' });
  });
  redis.on('connect', () => {
    logger.info('Connected to Redis for rate limiting');
  });
} else {
  logger.info('No REDIS_URL found. Using fallback in-memory rate limiting.');
}
