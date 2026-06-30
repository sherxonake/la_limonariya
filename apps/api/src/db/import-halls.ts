import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { halls } from "./schema";

// Per-hall service fee (owner-confirmed): Асосий 10 · Катта 10 · Терраса 15 · Собой 0
const HALLS: [string, number][] = [
  ["Асосий зал", 10],
  ["Катта зал", 10],
  ["Терраса", 15],
  ["Собой", 0],
];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const client = postgres(url, { max: 1 });
const db = drizzle(client);

await db
  .insert(halls)
  .values(HALLS.map(([name, pct], i) => ({ name, servicePct: pct, sort: i })))
  .onConflictDoUpdate({
    target: halls.name,
    set: { servicePct: sql`excluded.service_pct`, sort: sql`excluded.sort` },
  });

console.log(`halls: ${HALLS.length}`);
await client.end();
