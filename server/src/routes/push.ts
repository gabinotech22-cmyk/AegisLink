import { Router } from 'express';

const router = Router();

// POST /push/register has been removed (H-4 security fix).
// Push token registration is handled exclusively via the authenticated
// Socket.IO path: socket.on('push:register', ...) in relay/handler.ts.
// This ensures only authenticated clients (after Ed25519 challenge-response)
// can associate a push token with an aegisId.

export default router;
