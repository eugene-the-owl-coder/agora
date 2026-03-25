import crypto from 'crypto';
import bcrypt from 'bcrypt';

const API_KEY_BYTES = 32;
const BCRYPT_ROUNDS = 12;

export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const rawBytes = crypto.randomBytes(API_KEY_BYTES);
  const raw = `agora_${rawBytes.toString('hex')}`;
  const prefix = raw.substring(0, 14); // "agora_" + 8 hex chars
  // We'll hash synchronously for simplicity in generation
  const hash = bcrypt.hashSync(raw, BCRYPT_ROUNDS);
  return { raw, prefix, hash };
}

export async function verifyApiKey(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}
