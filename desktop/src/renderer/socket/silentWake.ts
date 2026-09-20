/**
 * silentWake.ts — which payloads must never wake the recipient's device.
 *
 * Phantom-notification fix (2026-09-20): with sealed transport the relay
 * cannot tell a read receipt from a message, so every queued envelope used to
 * raise the generic "new encrypted message" push. The SENDER now marks
 * protocol traffic that renders nothing with `wakeHint: 'silent'`; the relay
 * queues it as usual (drained on next open) but never pushes for it. Pure
 * module (no preload bridge) so vitest can cover it — mirrors
 * mobile/src/socket/client.ts SILENT_WAKE_TYPES / silentWakeHintFor and MUST
 * stay identical.
 */
export const SILENT_WAKE_TYPES: ReadonlySet<string> = new Set<string>([
  'typing', 'read_receipt', 'msg_delete', 'sender_key_dist', 'profile_update',
]);

/** `'silent'` for a payload that renders nothing; `undefined` for anything that might. */
export function silentWakeHintFor(payloadJson: string): 'silent' | undefined {
  try {
    const p = JSON.parse(payloadJson) as { type?: unknown; body?: unknown };
    if (typeof p.type !== 'string') return undefined;
    if (SILENT_WAKE_TYPES.has(p.type)) return 'silent';
    if (p.type === 'group_msg' && typeof p.body === 'string' && p.body.startsWith('[group:')) return 'silent';
    return undefined;
  } catch {
    return undefined;
  }
}
