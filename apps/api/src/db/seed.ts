import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hashPin, pinLookup } from "../auth";
import { branches, users } from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const sql = postgres(url, { max: 1 });
const db = drizzle(sql);

const existing = await db.select().from(users).limit(1);
if (existing.length > 0) {
  console.log("users already present, skip seed");
} else {
  const branch = (
    await db
      .insert(branches)
      .values({ name: "La Limonariya — Навоий" })
      .returning()
  )[0];
  if (!branch) throw new Error("branch insert failed");

  const seed = [
    { name: "Директор", role: "director" as const },
    { name: "Менежер", role: "manager" as const },
    { name: "Бозорчи", role: "buyer" as const },
    { name: "Кассир", role: "cashier" as const },
    ...Array.from({ length: 10 }, (_, i) => ({
      name: `Официант ${i + 1}`,
      role: "waiter" as const,
    })),
  ];

  await db.insert(users).values(seed.map((u) => ({ ...u, branchId: branch.id })));
  console.log(`seeded 1 branch + ${seed.length} users`);
}

// Bootstrap: director must be able to log in even on an already-seeded DB.
const directorPin = process.env.BOOTSTRAP_DIRECTOR_PIN ?? "1234";
const director = (
  await db.select().from(users).where(eq(users.role, "director")).limit(1)
)[0];
if (director && !director.pinHash) {
  await db
    .update(users)
    .set({ pinHash: hashPin(directorPin), pinLookup: pinLookup(directorPin) })
    .where(eq(users.id, director.id));
  console.log(`director bootstrap PIN set (${directorPin})`);
}

await sql.end();
