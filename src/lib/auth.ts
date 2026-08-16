import bcrypt from "bcryptjs";

/**
 * Password / PIN hashing helpers (bcryptjs — pure JS, no native build, safe on
 * Railway's single-instance Node deployment).
 *
 * MIGRATION STRATEGY (no lock-out):
 * Existing accounts were created with plaintext passwords/PINs. We do NOT force
 * everyone to reset. Instead:
 *   - verifySecret() accepts BOTH a bcrypt hash and a legacy plaintext value.
 *   - Write paths (new/changed passwords) always hash with bcrypt.
 *   - On a successful legacy-plaintext login, the caller transparently upgrades
 *     the stored value to a bcrypt hash (see the login routes).
 * This keeps the owner and every staff member able to log in while plaintext
 * values are gradually migrated to hashes.
 */

const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$/;
const BCRYPT_COST = 10;

/** True when `value` looks like a bcrypt hash (rather than a legacy plaintext). */
export function isHashed(value: string): boolean {
  return BCRYPT_HASH_RE.test(value);
}

/** Hash a plaintext password/PIN with bcrypt. */
export async function hashSecret(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/** Constant-time string equality for the legacy plaintext fallback path. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i += 1) {
    diff |= aBuf[i] ^ bBuf[i];
  }
  return diff === 0;
}

/**
 * Verify `plain` against a stored value that is EITHER a bcrypt hash (new) or a
 * legacy plaintext (old). Never throws for a malformed stored value.
 */
export async function verifySecret(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (isHashed(stored)) {
    try {
      return await bcrypt.compare(plain, stored);
    } catch {
      return false;
    }
  }
  // Legacy plaintext value — still accepted so existing accounts keep working.
  return safeEqual(plain, stored);
}
