import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
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

await sql.end();
