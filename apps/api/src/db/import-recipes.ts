import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { products, recipeItems, recipes } from "./schema";

type Seed = {
  recipes: {
    name: string;
    kind: string | null;
    category: string | null;
    yield_g: number | null;
    marinade: string | null;
    items: { name: string; qty_g: number | null; stock_hint: string | null }[];
  }[];
  aliases: Record<string, string[]>;
};

const seed: Seed = JSON.parse(
  readFileSync(new URL("./texkarta-seed.json", import.meta.url), "utf8"),
);

function toInt(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function norm(s: string): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[().,"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const alias = new Map<string, string>();
for (const [c, vars] of Object.entries(seed.aliases))
  for (const v of vars) alias.set(norm(v), norm(c));
const canon = (s: string) => alias.get(norm(s)) ?? norm(s);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const client = postgres(url, { max: 1 });
const db = drizzle(client);

const prodIndex = new Map<string, string>();
for (const p of await db
  .select({ id: products.id, name: products.name })
  .from(products))
  if (!prodIndex.has(norm(p.name))) prodIndex.set(norm(p.name), p.id);

await db.delete(recipeItems);
await db.delete(recipes);

let dishLinked = 0;
let itemLinked = 0;
let itemTotal = 0;

for (const r of seed.recipes) {
  const productId = prodIndex.get(norm(r.name)) ?? null;
  if (productId) dishLinked++;

  const rec = (
    await db
      .insert(recipes)
      .values({
        productId,
        name: r.name,
        kind: r.kind,
        category: r.category,
        yieldG: toInt(r.yield_g),
        marinade: r.marinade,
      })
      .returning()
  )[0];
  if (!rec) continue;

  const items = r.items.map((it, idx) => {
    const componentId =
      prodIndex.get(canon(it.name)) ?? prodIndex.get(norm(it.name)) ?? null;
    itemTotal++;
    if (componentId) itemLinked++;
    return {
      recipeId: rec.id,
      componentId,
      componentName: it.name,
      qtyG: toInt(it.qty_g),
      stockHint: it.stock_hint ?? null,
      sort: idx,
    };
  });
  if (items.length) await db.insert(recipeItems).values(items);
}

console.log(
  `recipes: ${seed.recipes.length} (dish→product ${dishLinked}), items linked ${itemLinked}/${itemTotal}`,
);
await client.end();
