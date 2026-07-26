/**
 * typingThrottle — pure decision for the sealed (mailbox-mode) typing indicator.
 *
 * A sealed typing signal is a full ratchet-encrypted mailbox message, so — unlike
 * the cheap plaintext `typing` socket event — we must NOT emit one per keystroke
 * (Chat calls emitTyping on every text change). This gates the sealed sends:
 *   - refresh "typing" at most once per window (< the receiver's 5 s auto-clear,
 *     so a continuing typist keeps the indicator alive without flooding), and
 *   - send "stopped" only when we previously announced "typing" (de-dupe).
 *
 * Kept pure and dependency-free so both platforms share the exact behaviour and
 * it is unit-testable without the socket module.
 */

export interface SealedTypingEntry {
  isTyping: boolean;
  /** Epoch ms of the last sealed typing signal actually sent to this peer. */
  at: number;
}

export const SEALED_TYPING_REFRESH_MS = 4000;

/**
 * @param prev  the last sealed typing signal sent to this peer (undefined = none)
 * @param isTyping  the new state the caller wants to announce
 * @param now  current epoch ms
 * @returns true when a sealed message should actually be sent
 */
export function shouldSendSealedTyping(
  prev: SealedTypingEntry | undefined,
  isTyping: boolean,
  now: number,
  refreshMs: number = SEALED_TYPING_REFRESH_MS,
): boolean {
  if (isTyping) {
    // Throttle refreshes: skip while a recent "typing" is still keeping the
    // indicator alive on the receiver.
    return !(prev?.isTyping === true && now - prev.at < refreshMs);
  }
  // Only announce "stopped" if we had previously announced "typing".
  return prev?.isTyping === true;
}
