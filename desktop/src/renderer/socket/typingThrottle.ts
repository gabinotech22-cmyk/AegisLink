/**
 * typingThrottle — pure decision for the sealed (mailbox-mode) typing indicator.
 *
 * Mirrors mobile/src/socket/typingThrottle.ts byte-for-byte so both platforms
 * throttle sealed typing identically. A sealed typing signal is a full
 * ratchet-encrypted mailbox message, so — unlike the cheap plaintext `typing`
 * socket event — we must NOT emit one per keystroke. This gates the sealed sends:
 * refresh "typing" at most once per window (< the receiver's 5 s auto-clear), and
 * send "stopped" only when we previously announced "typing".
 *
 * Kept pure and dependency-free so it is unit-testable without the socket module
 * (which touches the window.aegis preload bridge).
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
    return !(prev?.isTyping === true && now - prev.at < refreshMs);
  }
  return prev?.isTyping === true;
}
