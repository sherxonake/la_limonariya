import { sql } from "drizzle-orm";
import { db } from "./db/client";
import { users } from "./db/schema";
import { publicProcedure, router } from "./trpc";

export const appRouter = router({
  health: publicProcedure.query(async () => {
    await db.execute(sql`select 1`);
    return { ok: true, ts: new Date().toISOString() };
  }),
  users: router({
    list: publicProcedure.query(async () => {
      return db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
        })
        .from(users)
        .orderBy(users.role, users.name);
    }),
  }),
});

export type AppRouter = typeof appRouter;
