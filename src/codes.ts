import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
// No I/O/0/1, so a read-aloud code isn't ambiguous.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface HashedCode {
  hash: string;
  salt: string;
}

export function hashCode(code: string): HashedCode {
  const salt = randomBytes(16);
  const hash = scryptSync(code, salt, KEY_LENGTH);
  return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

// Fails closed: a lecture with no code set (null hash/salt) always rejects,
// rather than letting scryptSync throw on a null salt.
export function verifyCode(code: string, hash: string | null, salt: string | null): boolean {
  if (!hash || !salt) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(code, Buffer.from(salt, "hex"), KEY_LENGTH);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function generateAccessCode(length = 8): string {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[randomInt(CODE_CHARS.length)];
  }
  return code;
}
