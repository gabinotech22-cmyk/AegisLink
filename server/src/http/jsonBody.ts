import express, { type RequestHandler } from 'express';

/**
 * Body-size policy for the relay's JSON API.
 *
 * The API-wide parser stays at 64 KB — every control-plane endpoint is tiny and
 * a small cap is the cheapest DoS guard. The ONLY endpoint that legitimately
 * carries a large JSON body is the encrypted backup (`PUT /backup`, envelope up
 * to 5 MB), which mounts its own parser (routes/backup.ts).
 *
 * Audit 2026-09-16 AL-08: the global 64 KB parser used to run first for every
 * path, so any backup above ~64 KB was rejected with 413 before the 5 MB check
 * in the backup router could ever see it. Skip `/backup` here; the backup router
 * parses with its own limit.
 */
export const GLOBAL_JSON_LIMIT = '64kb';
export const BACKUP_JSON_LIMIT = '5mb';

const apiJson = express.json({ limit: GLOBAL_JSON_LIMIT });

export const globalJsonParser: RequestHandler = (req, res, next) => {
  if (req.path === '/backup' || req.path.startsWith('/backup/')) { next(); return; }
  apiJson(req, res, next);
};

/** The backup router's own parser — larger cap, JSON only. */
export const backupJsonParser: RequestHandler = express.json({ limit: BACKUP_JSON_LIMIT });
