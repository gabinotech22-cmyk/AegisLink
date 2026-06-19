// Typed, module-scoped bus for live poll-tally updates.
//
// Replaces a previous `globalThis.aegisEmitPollUpdate` mutable, which any module
// in the process could overwrite or invoke with arbitrary data. Access is now
// import-only and typed: the relay registers the real emitter once at startup,
// and the polls route calls `emitPollUpdate`. (Golden rule #6.)

type PollUpdateFn = (pollId: string, counts: number[]) => void;

let emitFn: PollUpdateFn | null = null;

/** Called once by the relay at startup to wire the Socket.IO broadcast. */
export function setPollUpdateEmitter(fn: PollUpdateFn): void {
  emitFn = fn;
}

/** Emit a poll tally update; no-op until the relay has registered an emitter. */
export function emitPollUpdate(pollId: string, counts: number[]): void {
  emitFn?.(pollId, counts);
}
