import {
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const pepper = process.env.PIN_PEPPER ?? "dev-pepper-change-me";

// Deterministic, unique-able lookup so a PIN alone finds its user (O(1) indexed).
export function pinLookup(pin: string): string {
  return createHmac("sha256", pepper).update(pin).digest("hex");
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(pin, Buffer.from(saltHex, "hex"), 32);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

// --- PIN login rate limiting ---
// In-memory, per-client-IP. Single-process API (see docker-compose.yml — one
// api container), so this is sufficient for MVP scale (one restaurant, a
// handful of terminals) without adding Redis. Resets on API restart —
// acceptable: a restart is rare and doesn't itself indicate an attack.
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

type AttemptState = { count: number; windowStart: number; lockedUntil: number | null };
const loginAttempts = new Map<string, AttemptState>();

export function checkLoginRateLimit(key: string): { blocked: boolean; retryAfterMs: number } {
  const s = loginAttempts.get(key);
  if (!s?.lockedUntil) return { blocked: false, retryAfterMs: 0 };
  const remaining = s.lockedUntil - Date.now();
  if (remaining <= 0) {
    loginAttempts.delete(key);
    return { blocked: false, retryAfterMs: 0 };
  }
  return { blocked: true, retryAfterMs: remaining };
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const s = loginAttempts.get(key);
  if (!s || now - s.windowStart > WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now, lockedUntil: null });
    return;
  }
  s.count += 1;
  if (s.count >= MAX_ATTEMPTS) s.lockedUntil = now + LOCKOUT_MS;
}

export function clearLoginAttempts(key: string): void {
  loginAttempts.delete(key);
}
