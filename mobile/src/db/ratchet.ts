import { withDb, encryptBody, decryptSecretOrNull } from './core';

export interface StoredRatchetSession {
  aegisId: string;
  stateJson: string;
}

export async function saveRatchetSession(aegisId: string, stateJson: string): Promise<void> {
  return withDb(async (d) => {
    const encrypted = await encryptBody(stateJson);
    await d.runAsync(
      `INSERT OR REPLACE INTO ratchet_sessions (aegis_id, state_json) VALUES (?, ?)`,
      aegisId,
      encrypted
    );
  });
}

export async function loadRatchetSession(aegisId: string): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ state_json: string }>(
      `SELECT state_json FROM ratchet_sessions WHERE aegis_id = ?`,
      aegisId
    );
    if (!row) return null;
    // Fail closed: if the stored ratchet state cannot be decrypted, return null
    // so the caller re-establishes a fresh session rather than proceeding with a
    // sentinel string that would parse into garbage key material (golden rule #1).
    return decryptSecretOrNull(row.state_json);
  });
}
