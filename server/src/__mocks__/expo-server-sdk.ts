/**
 * Minimal mock of expo-server-sdk for Jest tests.
 * expo-server-sdk ships as native ESM (uses import.meta.url) which ts-jest
 * cannot transform in CJS mode — this stub replaces it entirely so the push
 * module compiles without touching the real SDK.
 */

export type ExpoPushMessage = {
  to: string | string[];
  title?: string;
  body?: string;
  sound?: 'default' | null;
  data?: Record<string, unknown>;
  priority?: 'default' | 'normal' | 'high';
  ttl?: number;
  _contentAvailable?: boolean;
};

export type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export class Expo {
  static isExpoPushToken(_token: string): boolean {
    return _token.startsWith('ExponentPushToken[');
  }

  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][] {
    // Return a single chunk for simplicity
    return [messages];
  }

  async sendPushNotificationsAsync(
    _messages: ExpoPushMessage[],
  ): Promise<ExpoPushTicket[]> {
    // No-op in tests — no real push tokens exist
    return _messages.map(() => ({ status: 'ok' as const, id: 'mock-ticket' }));
  }
}
