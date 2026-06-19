import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { pollsRepo } from '../db/client.js';
import { emitPollUpdate } from '../relay/pollBus.js';

const router = Router();

// Rate limiter. Voting was previously unauthenticated AND unthrottled, allowing
// trivial ballot stuffing (voterHash is client-supplied). The IP is used only by
// the in-memory limiter store — never persisted or logged (zero-metadata).
const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

const tallyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

const VoteSchema = z.object({
  pollId: z.string().min(1).max(128),
  voterHash: z.string().min(1).max(128),
  optionIndex: z.number().int().nonnegative().max(64),
});

// POST /polls/vote
router.post('/vote', voteLimiter, async (req, res) => {
  const parsed = VoteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload' });
  }

  const { pollId, voterHash, optionIndex } = parsed.data;

  try {
    await pollsRepo.vote(pollId, voterHash, optionIndex);
    const counts = await pollsRepo.getTally(pollId);

    emitPollUpdate(pollId, counts);

    res.json({ ok: true, counts });
  } catch (err) {
    res.status(500).json({ error: 'database_error' });
  }
});

// GET /polls/:pollId
router.get('/:pollId', tallyLimiter, async (req, res) => {
  const pollId = String(req.params.pollId);
  if (!pollId) {
    return res.status(400).json({ error: 'missing_poll_id' });
  }

  try {
    const counts = await pollsRepo.getTally(pollId);
    res.json({ counts });
  } catch (err) {
    res.status(500).json({ error: 'database_error' });
  }
});

export default router;
