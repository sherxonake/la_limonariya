import { eq } from "drizzle-orm";
import type { Context as HonoContext } from "hono";
import { getCookie } from "hono/cookie";
import { hashToken } from "./auth";
import { db } from "./db/client";
import { sessions, users } from "./db/schema";

export const SESSION_COOKIE = "limon_session";

export type SessionUser = { id: string; name: string; role: string };

export async function createContext(_opts: unknown, c: HonoContext) {
  let user: SessionUser | null = null;
  const token = getCookie(c, SESSION_COOKIE);

  if (token) {
    const row = (
      await db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.tokenHash, hashToken(token)))
        .limit(1)
    )[0];

    if (row && row.active && row.expiresAt > new Date()) {
      user = { id: row.id, name: row.name, role: row.role };
    }
  }

  return { c, user };
}

export type Ctx = Awaited<ReturnType<typeof createContext>>;
