import * as Crypto from 'expo-crypto';
import { ss } from '../utils/secureStore';

const PIN_HASH_KEY = 'aegis.pin.hash';
const PIN_SALT = 'aegislink:pin:v1:';
export const DURESS_PIN_SALT = 'aegislink:panic:v1:';

async function hashPin(pin: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    PIN_SALT + pin
  );
}

export async function hashPinWithSalt(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    salt + pin
  );
}

export async function setPIN(pin: string): Promise<void> {
  const hash = await hashPin(pin);
  await ss.set(PIN_HASH_KEY, hash);
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await ss.get(PIN_HASH_KEY);
  if (!stored) return false;
  const hash = await hashPin(pin);
  return hash === stored;
}

export async function hasStoredPIN(): Promise<boolean> {
  const val = await ss.get(PIN_HASH_KEY);
  return val !== null && val.length > 0;
}

export async function clearPIN(): Promise<void> {
  await ss.delete(PIN_HASH_KEY);
}
