import Redis from 'ioredis';
import { logger } from './logger.js';

const REDIS_URL = process.env.REDIS_URL;

export const redis = REDIS_URL ? new Redis(REDIS_URL) : null;

if (redis) {
  redis.on('error', (err) => {
    logger.error('Redis connection error', { error: err instanceof Error ? err.message : String(err) });
  });
  redis.on('connect', () => {
    logger.info('Connected to Redis for rate limiting');
  });
} else {
  logger.info('No REDIS_URL found. Using fallback in-memory rate limiting.');
}
