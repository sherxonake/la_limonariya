import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  hashPin,
  hashToken,
  newSessionToken,
  pinLookup,
  verifyPin,
} from "./auth";
import { SESSION_COOKIE } from "./context";
import { db } from "./db/client";
import {
  categories,
  expenses,
  halls,
  obvalka,
  obvalkaParts,
  orderItems,
  orderPayments,
  orders,
  partTypes,
  products,
  purchaseItems,
  purchases,
  recipeItems,
  recipes,
  sessions,
  stations,
  stockMovements,
  users,
} from "./db/schema";
import { computeObvalka } from "./obvalka-calc";
import { businessDayBounds, businessRangeBounds } from "./time";
import { TRPCError } from "@trpc/server";
import {
  directorProcedure,
  managerProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from "./trpc";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const pinSchema = z.string().regex(/^\d{4}$/, "PIN — 4 ta raqam");

// Real per-kg meat cost = cost of the latest recorded carcass of this type.
async function latestMeatCost(ct: "qoy" | "mol"): Promise<number | null> {
  const head = (
    await db
      .select()
      .from(obvalka)
      .where(eq(obvalka.carcassType, ct))
      .orderBy(desc(obvalka.createdAt))
      .limit(1)
  )[0];
  if (!head) return null;
  const parts = await db
    .select({
      name: obvalkaParts.name,
      weightG: obvalkaParts.weightG,
      isWaste: partTypes.isWaste,
      normMinPct: partTypes.normMinPct,
      normMaxPct: partTypes.normMaxPct,
    })
    .from(obvalkaParts)
    .leftJoin(partTypes, eq(obvalkaParts.partTypeId, partTypes.id))
    .where(eq(obvalkaParts.obvalkaId, head.id));
  const c = computeObvalka(
    head.weightG,
    head.pricePerKg,
    parts.map((p) => ({
      name: p.name,
      weightG: p.weightG,
      isWaste: p.isWaste ?? false,
      normMinPct: p.normMinPct,
      normMaxPct: p.normMaxPct,
    })),
  );
  return c.costPerKg || null;
}

// Per-dish meat cost: Σ (meat-ingredient grams × current per-kg meat cost).
// Meat is detected from recipe item stock_hint; carcass from мол/қўй in hint/category.
async function computeDishTaannarx(meatCost: {
  qoy: number | null;
  mol: number | null;
}) {
  const recs = await db
    .select({
      id: recipes.id,
      name: recipes.name,
      kind: recipes.kind,
      category: recipes.category,
      salePrice: products.price,
    })
    .from(recipes)
    .leftJoin(products, eq(recipes.productId, products.id))
    .orderBy(recipes.kind, recipes.name);

  const items = await db
    .select({
      recipeId: recipeItems.recipeId,
      qtyG: recipeItems.qtyG,
      stockHint: recipeItems.stockHint,
    })
    .from(recipeItems);
  const byRecipe = new Map<
    string,
    { qtyG: number | null; stockHint: string | null }[]
  >();
  for (const it of items) {
    const a = byRecipe.get(it.recipeId) ?? [];
    a.push(it);
    byRecipe.set(it.recipeId, a);
  }

  const carcassOf = (
    hint: string | null,
    category: string | null,
  ): "qoy" | "mol" | null => {
    if (!/обвалка|лаҳм|гўшт|гушт/i.test(`${hint ?? ""}`)) return null;
    const s = `${hint ?? ""} ${category ?? ""}`;
    if (/мол/i.test(s)) return "mol";
    if (/қўй|қуй|куй/i.test(s)) return "qoy";
    return null;
  };

  return recs.map((r) => {
    let meatCostTotal = 0;
    let meatG = 0;
    for (const it of byRecipe.get(r.id) ?? []) {
      const c = carcassOf(it.stockHint, r.category);
      const cost = c ? meatCost[c] : null;
      if (c && cost && it.qtyG) {
        meatCostTotal += (it.qtyG / 1000) * cost;
        meatG += it.qtyG;
      }
    }
    meatCostTotal = Math.round(meatCostTotal);
    const salePrice = r.salePrice ?? 0;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      salePrice,
      meatCostTotal,
      meatG,
      meatPct:
        salePrice > 0 ? Math.round((meatCostTotal / salePrice) * 100) : null,
    };
  });
}

// CRITICAL: products.costPrice is per-DISPLAY-unit (per-kg / per-dona / per-l),
// set in purchase.create as price/qty. baseAbs is in base units (g for kg/g,
// ml for l/ml, dona). Carcass meat (Мол/Қўй лаҳм) has NULL costPrice — value via
// per-kg carcass cost instead. Returns null when cost is unknown.
function valuePortion(
  baseAbs: number,
  unit: string,
  costPrice: number | null,
  carcassPerKg: number | null,
): number | null {
  if (carcassPerKg != null) return Math.round((baseAbs / 1000) * carcassPerKg);
  if (costPrice == null) return null;
  const div = unit === "kg" || unit === "l" ? 1000 : 1;
  return Math.round((baseAbs / div) * costPrice);
}

// COGS for a window = Σ valued sale_writeoff movements. Partial by design:
// списание skips soldByWeight/no-recipe/unmapped items, and some products lack
// a costPrice → reported as unpriced so the UI can flag "COGS qisman".
async function cogsForWindow(start: Date, end: Date) {
  const meat = {
    qoy: await latestMeatCost("qoy"),
    mol: await latestMeatCost("mol"),
  };
  const rows = await db
    .select({
      qty: stockMovements.qty,
      name: products.name,
      unit: products.unit,
      costPrice: products.costPrice,
    })
    .from(stockMovements)
    .innerJoin(products, eq(stockMovements.productId, products.id))
    .where(
      and(
        eq(stockMovements.type, "sale_writeoff"),
        gte(stockMovements.createdAt, start),
        lt(stockMovements.createdAt, end),
      ),
    );
  let cogs = 0;
  let priced = 0;
  const unpriced = new Set<string>();
  for (const r of rows) {
    const carc =
      r.name === "Мол лаҳм" ? meat.mol : r.name === "Қўй лаҳм" ? meat.qoy : null;
    const v = valuePortion(Math.abs(r.qty), r.unit, r.costPrice, carc);
    if (v == null) {
      unpriced.add(r.name);
      continue;
    }
    cogs += v;
    priced++;
  }
  return {
    cogs,
    priced,
    unpricedCount: unpriced.size,
    unpricedNames: [...unpriced].slice(0, 10),
  };
}

// Shared revenue/COGS/OPEX aggregation over a UTC window — used by dayClose + pnl.
async function financeForWindow(start: Date, end: Date) {
  const payRows = await db
    .select({ method: orderPayments.method, amount: orderPayments.amount })
    .from(orderPayments)
    .innerJoin(orders, eq(orderPayments.orderId, orders.id))
    .where(
      and(
        eq(orders.status, "closed"),
        gte(orders.closedAt, start),
        lt(orders.closedAt, end),
      ),
    );
  const byMethod: Record<string, number> = {};
  let revenue = 0;
  for (const p of payRows) {
    byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
    // debt = receivable (cash not received) — kept as guestDebt, NOT realized revenue
    if (p.method !== "debt") revenue += p.amount;
  }
  const electronic =
    (byMethod.card ?? 0) + (byMethod.click ?? 0) + (byMethod.payme ?? 0);
  const cardTax = Math.round((electronic * 4) / 100);
  const guestDebt = byMethod.debt ?? 0;

  const checks = Number(
    (
      await db
        .select({ n: count() })
        .from(orders)
        .where(
          and(
            eq(orders.status, "closed"),
            gte(orders.closedAt, start),
            lt(orders.closedAt, end),
          ),
        )
    )[0]?.n ?? 0,
  );

  const cogsRes = await cogsForWindow(start, end);

  const expRows = await db
    .select({ category: expenses.category, amount: expenses.amount })
    .from(expenses)
    .where(and(gte(expenses.spentAt, start), lt(expenses.spentAt, end)));
  let opex = 0;
  const opexByCat: Record<string, number> = {};
  for (const e of expRows) {
    opex += e.amount;
    opexByCat[e.category] = (opexByCat[e.category] ?? 0) + e.amount;
  }

  const sofFoyda = revenue - cogsRes.cogs - opex - cardTax;
  return {
    revenue,
    byMethod,
    cardTax,
    guestDebt,
    checks,
    avgCheck: checks ? Math.round(revenue / checks) : 0,
    cogs: cogsRes.cogs,
    // partial = some movements unpriced OR there's revenue but списание produced
    // no COGS at all (salads/drinks/by-weight items never write sale_writeoff)
    cogsPartial:
      cogsRes.unpricedCount > 0 || (revenue > 0 && cogsRes.cogs === 0),
    unpricedCount: cogsRes.unpricedCount,
    unpricedNames: cogsRes.unpricedNames,
    opex,
    opexByCat,
    sofFoyda,
  };
}

export const appRouter = router({
  health: publicProcedure.query(async () => {
    await db.execute(sql`select 1`);
    return { ok: true, ts: new Date().toISOString() };
  }),

  auth: router({
    login: publicProcedure
      .input(z.object({ pin: pinSchema }))
      .mutation(async ({ input, ctx }) => {
        const u = (
          await db
            .select()
            .from(users)
            .where(
              and(eq(users.pinLookup, pinLookup(input.pin)), eq(users.active, true)),
            )
            .limit(1)
        )[0];

        if (!u || !u.pinHash || !verifyPin(input.pin, u.pinHash)) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "PIN noto'g'ri" });
        }

        const { token, tokenHash } = newSessionToken();
        const expiresAt = new Date(Date.now() + SESSION_MS);
        await db.insert(sessions).values({ userId: u.id, tokenHash, expiresAt });
        setCookie(ctx.c, SESSION_COOKIE, token, {
          httpOnly: true,
          sameSite: "Lax",
          path: "/",
          expires: expiresAt,
        });

        return { id: u.id, name: u.name, role: u.role };
      }),

    me: publicProcedure.query(({ ctx }) => ctx.user),

    logout: publicProcedure.mutation(async ({ ctx }) => {
      const token = getCookie(ctx.c, SESSION_COOKIE);
      if (token) {
        await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
        deleteCookie(ctx.c, SESSION_COOKIE, { path: "/" });
      }
      return { ok: true };
    }),
  }),

  users: router({
    list: protectedProcedure.query(async () => {
      return db
        .select({
          id: users.id,
          name: users.name,
          role: users.role,
          active: users.active,
          hasPin: sql<boolean>`${users.pinHash} is not null`,
        })
        .from(users)
        .orderBy(users.role, users.name);
    }),

    setPin: directorProcedure
      .input(z.object({ userId: z.string().uuid(), pin: pinSchema }))
      .mutation(async ({ input }) => {
        try {
          await db
            .update(users)
            .set({ pinHash: hashPin(input.pin), pinLookup: pinLookup(input.pin) })
            .where(eq(users.id, input.userId));
        } catch (e) {
          if (e && typeof e === "object" && "code" in e && e.code === "23505") {
            throw new TRPCError({ code: "CONFLICT", message: "Бу PIN банд" });
          }
          throw e;
        }
        return { ok: true };
      }),
  }),

  catalog: router({
    categories: protectedProcedure.query(async () => {
      return db
        .select({
          id: categories.id,
          name: categories.name,
          position: categories.position,
        })
        .from(categories)
        .where(eq(categories.active, true))
        .orderBy(categories.position, categories.name);
    }),

    products: protectedProcedure
      .input(z.object({ categoryId: z.string().uuid().optional() }).optional())
      .query(async ({ input }) => {
        return db
          .select({
            id: products.id,
            name: products.name,
            type: products.type,
            unit: products.unit,
            price: products.price,
            soldByWeight: products.soldByWeight,
            category: categories.name,
            station: stations.name,
          })
          .from(products)
          .leftJoin(categories, eq(products.categoryId, categories.id))
          .leftJoin(stations, eq(products.stationId, stations.id))
          .where(
            and(
              eq(products.active, true),
              input?.categoryId
                ? eq(products.categoryId, input.categoryId)
                : undefined,
            ),
          )
          .orderBy(products.type, products.name);
      }),

    recipes: protectedProcedure.query(async () => {
      return db
        .select({
          id: recipes.id,
          name: recipes.name,
          kind: recipes.kind,
          category: recipes.category,
          yieldG: recipes.yieldG,
          linked: sql<boolean>`${recipes.productId} is not null`,
        })
        .from(recipes)
        .orderBy(recipes.kind, recipes.name);
    }),

    recipe: protectedProcedure
      .input(z.object({ recipeId: z.string().uuid() }))
      .query(async ({ input }) => {
        return db
          .select({
            componentName: recipeItems.componentName,
            qtyG: recipeItems.qtyG,
            stockHint: recipeItems.stockHint,
            product: products.name,
          })
          .from(recipeItems)
          .leftJoin(products, eq(recipeItems.componentId, products.id))
          .where(eq(recipeItems.recipeId, input.recipeId))
          .orderBy(recipeItems.sort);
      }),
  }),

  obvalka: router({
    partTypes: protectedProcedure
      .input(z.object({ carcassType: z.enum(["qoy", "mol"]) }))
      .query(async ({ input }) => {
        return db
          .select({
            id: partTypes.id,
            name: partTypes.name,
            normMinPct: partTypes.normMinPct,
            normMaxPct: partTypes.normMaxPct,
            isWaste: partTypes.isWaste,
          })
          .from(partTypes)
          .where(eq(partTypes.carcassType, input.carcassType))
          .orderBy(partTypes.sort);
      }),

    list: protectedProcedure.query(async () => {
      return db
        .select({
          id: obvalka.id,
          carcassType: obvalka.carcassType,
          weightG: obvalka.weightG,
          pricePerKg: obvalka.pricePerKg,
          supplier: obvalka.supplier,
          createdAt: obvalka.createdAt,
        })
        .from(obvalka)
        .orderBy(desc(obvalka.createdAt))
        .limit(50);
    }),

    get: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        const head = (
          await db.select().from(obvalka).where(eq(obvalka.id, input.id)).limit(1)
        )[0];
        if (!head) throw new TRPCError({ code: "NOT_FOUND" });
        const parts = await db
          .select({
            name: obvalkaParts.name,
            weightG: obvalkaParts.weightG,
            isWaste: partTypes.isWaste,
            normMinPct: partTypes.normMinPct,
            normMaxPct: partTypes.normMaxPct,
          })
          .from(obvalkaParts)
          .leftJoin(partTypes, eq(obvalkaParts.partTypeId, partTypes.id))
          .where(eq(obvalkaParts.obvalkaId, input.id));
        const computed = computeObvalka(
          head.weightG,
          head.pricePerKg,
          parts.map((p) => ({
            name: p.name,
            weightG: p.weightG,
            isWaste: p.isWaste ?? false,
            normMinPct: p.normMinPct,
            normMaxPct: p.normMaxPct,
          })),
        );
        return {
          id: head.id,
          carcassType: head.carcassType,
          weightG: head.weightG,
          pricePerKg: head.pricePerKg,
          supplier: head.supplier,
          createdAt: head.createdAt,
          ...computed,
        };
      }),

    create: protectedProcedure
      .input(
        z.object({
          carcassType: z.enum(["qoy", "mol"]),
          weightG: z.number().int().positive(),
          pricePerKg: z.number().int().nonnegative(),
          supplier: z.string().optional(),
          note: z.string().optional(),
          parts: z
            .array(
              z.object({
                partTypeId: z.string().uuid(),
                weightG: z.number().int().nonnegative(),
              }),
            )
            .min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return db.transaction(async (tx) => {
          const row = (
            await tx
              .insert(obvalka)
              .values({
                carcassType: input.carcassType,
                weightG: input.weightG,
                pricePerKg: input.pricePerKg,
                supplier: input.supplier ?? null,
                note: input.note ?? null,
                createdById: ctx.user.id,
              })
              .returning()
          )[0];
          if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

          const ptList = await tx
            .select()
            .from(partTypes)
            .where(eq(partTypes.carcassType, input.carcassType));
          const ptMap = new Map(ptList.map((p) => [p.id, p]));
          const parts = input.parts.filter((p) => p.weightG > 0);
          if (parts.length)
            await tx.insert(obvalkaParts).values(
              parts.map((p) => ({
                obvalkaId: row.id,
                partTypeId: p.partTypeId,
                name: ptMap.get(p.partTypeId)?.name ?? "?",
                weightG: p.weightG,
              })),
            );

          // Carcass-level meat inflow = sum of sellable (non-waste) flesh.
          const sellableG = parts.reduce((s, p) => {
            const pt = ptMap.get(p.partTypeId);
            return pt && !pt.isWaste ? s + p.weightG : s;
          }, 0);
          const carcassName =
            input.carcassType === "mol" ? "Мол лаҳм" : "Қўй лаҳм";
          const cp = (
            await tx
              .select({ id: products.id })
              .from(products)
              .where(eq(products.name, carcassName))
              .orderBy(products.createdAt)
              .limit(1)
          )[0];
          if (cp && sellableG > 0)
            await tx.insert(stockMovements).values({
              productId: cp.id,
              type: "obvalka",
              qty: sellableG,
              unit: "g",
              refType: "obvalka",
              refId: row.id,
              createdById: ctx.user.id,
            });

          return { id: row.id };
        });
      }),
  }),

  taannarx: router({
    list: directorProcedure.query(async () => {
      const meatCost = {
        qoy: await latestMeatCost("qoy"),
        mol: await latestMeatCost("mol"),
      };
      return { meatCost, dishes: await computeDishTaannarx(meatCost) };
    }),
  }),

  dashboard: router({
    summary: directorProcedure.query(async () => {
      const meatCost = {
        qoy: await latestMeatCost("qoy"),
        mol: await latestMeatCost("mol"),
      };

      const typeRows = await db
        .select({ type: products.type, n: count() })
        .from(products)
        .groupBy(products.type);
      const catalog: Record<string, number> = {};
      for (const r of typeRows) catalog[r.type] = Number(r.n);
      const recipeCount = Number(
        (await db.select({ n: count() }).from(recipes))[0]?.n ?? 0,
      );

      const recent = await db
        .select()
        .from(obvalka)
        .orderBy(desc(obvalka.createdAt))
        .limit(6);
      const recentObvalka = [];
      for (const o of recent) {
        const parts = await db
          .select({
            name: obvalkaParts.name,
            weightG: obvalkaParts.weightG,
            isWaste: partTypes.isWaste,
            normMinPct: partTypes.normMinPct,
            normMaxPct: partTypes.normMaxPct,
          })
          .from(obvalkaParts)
          .leftJoin(partTypes, eq(obvalkaParts.partTypeId, partTypes.id))
          .where(eq(obvalkaParts.obvalkaId, o.id));
        const c = computeObvalka(
          o.weightG,
          o.pricePerKg,
          parts.map((p) => ({
            name: p.name,
            weightG: p.weightG,
            isWaste: p.isWaste ?? false,
            normMinPct: p.normMinPct,
            normMaxPct: p.normMaxPct,
          })),
        );
        recentObvalka.push({
          id: o.id,
          carcassType: o.carcassType,
          weightG: o.weightG,
          supplier: o.supplier,
          createdAt: o.createdAt,
          lossPct: c.lossPct,
          balanceFlag: c.balanceFlag,
          costPerKg: c.costPerKg,
          anomalies: c.items.filter((i) => i.outOfNorm).length,
        });
      }

      const dishes = await computeDishTaannarx(meatCost);
      const thinDishes = dishes
        .filter(
          (d) =>
            d.salePrice > 0 &&
            d.meatCostTotal > 0 &&
            d.meatPct != null &&
            d.meatPct <= 100,
        )
        .sort((a, b) => (b.meatPct ?? 0) - (a.meatPct ?? 0))
        .slice(0, 6);

      return { meatCost, catalog, recipeCount, recentObvalka, thinDishes };
    }),
  }),

  pos: router({
    halls: protectedProcedure.query(async () => {
      return db
        .select({
          id: halls.id,
          name: halls.name,
          servicePct: halls.servicePct,
        })
        .from(halls)
        .orderBy(halls.sort);
    }),

    menu: protectedProcedure.query(async () => {
      return db
        .select({
          id: products.id,
          name: products.name,
          price: products.price,
          category: categories.name,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(and(eq(products.active, true), sql`${products.price} > 0`))
        .orderBy(products.type, products.name);
    }),

    openOrders: protectedProcedure.query(async () => {
      const rows = await db
        .select({
          id: orders.id,
          tableNo: orders.tableNo,
          createdAt: orders.createdAt,
          hall: halls.name,
          waiter: users.name,
          qty: sql<number>`coalesce(sum(${orderItems.qty}), 0)`,
          total: sql<number>`coalesce(sum(${orderItems.qty} * ${orderItems.price}), 0)`,
        })
        .from(orders)
        .leftJoin(halls, eq(orders.hallId, halls.id))
        .leftJoin(users, eq(orders.waiterId, users.id))
        .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
        .where(eq(orders.status, "open"))
        .groupBy(orders.id, halls.name, users.name)
        .orderBy(desc(orders.createdAt));
      return rows.map((r) => ({ ...r, qty: Number(r.qty), total: Number(r.total) }));
    }),

    order: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        const head = (
          await db
            .select({
              id: orders.id,
              tableNo: orders.tableNo,
              status: orders.status,
              servicePct: orders.servicePct,
              createdAt: orders.createdAt,
              closedAt: orders.closedAt,
              hall: halls.name,
              waiter: users.name,
            })
            .from(orders)
            .leftJoin(halls, eq(orders.hallId, halls.id))
            .leftJoin(users, eq(orders.waiterId, users.id))
            .where(eq(orders.id, input.id))
            .limit(1)
        )[0];
        if (!head) throw new TRPCError({ code: "NOT_FOUND" });
        const items = await db
          .select({
            id: orderItems.id,
            productId: orderItems.productId,
            name: orderItems.name,
            price: orderItems.price,
            qty: orderItems.qty,
          })
          .from(orderItems)
          .where(eq(orderItems.orderId, input.id));
        const payments = await db
          .select({ method: orderPayments.method, amount: orderPayments.amount })
          .from(orderPayments)
          .where(eq(orderPayments.orderId, input.id));
        const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
        const service = Math.round((subtotal * head.servicePct) / 100);
        return {
          ...head,
          checkNo: input.id.slice(0, 5).toUpperCase(),
          items,
          payments,
          subtotal,
          service,
          total: subtotal + service,
        };
      }),

    create: protectedProcedure
      .input(
        z.object({ hallId: z.string().uuid(), tableNo: z.string().optional() }),
      )
      .mutation(async ({ input, ctx }) => {
        const hall = (
          await db.select().from(halls).where(eq(halls.id, input.hallId)).limit(1)
        )[0];
        if (!hall) throw new TRPCError({ code: "NOT_FOUND" });
        const row = (
          await db
            .insert(orders)
            .values({
              hallId: hall.id,
              tableNo: input.tableNo ?? null,
              waiterId: ctx.user.id,
              servicePct: hall.servicePct,
            })
            .returning()
        )[0];
        if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        return { id: row.id };
      }),

    addItem: protectedProcedure
      .input(
        z.object({
          orderId: z.string().uuid(),
          productId: z.string().uuid(),
          delta: z.number().int(),
        }),
      )
      .mutation(async ({ input }) => {
        const existing = (
          await db
            .select()
            .from(orderItems)
            .where(
              and(
                eq(orderItems.orderId, input.orderId),
                eq(orderItems.productId, input.productId),
              ),
            )
            .limit(1)
        )[0];
        if (existing) {
          const qty = existing.qty + input.delta;
          if (qty <= 0)
            await db.delete(orderItems).where(eq(orderItems.id, existing.id));
          else
            await db
              .update(orderItems)
              .set({ qty })
              .where(eq(orderItems.id, existing.id));
        } else if (input.delta > 0) {
          const p = (
            await db
              .select()
              .from(products)
              .where(eq(products.id, input.productId))
              .limit(1)
          )[0];
          if (!p) throw new TRPCError({ code: "NOT_FOUND" });
          await db.insert(orderItems).values({
            orderId: input.orderId,
            productId: p.id,
            name: p.name,
            price: p.price,
            qty: input.delta,
          });
        }
        return { ok: true };
      }),

    close: protectedProcedure
      .input(
        z.object({
          id: z.string().uuid(),
          payments: z
            .array(
              z.object({
                method: z.enum(["cash", "card", "click", "payme", "debt"]),
                amount: z.number().int().nonnegative(),
              }),
            )
            .optional(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return db.transaction(async (tx) => {
          // Idempotent: only the tx that flips open→closed writes payments + списание.
          const flipped = await tx
            .update(orders)
            .set({
              status: "closed",
              closedAt: new Date(),
              closedById: ctx.user.id,
            })
            .where(and(eq(orders.id, input.id), eq(orders.status, "open")))
            .returning({ id: orders.id });
          if (flipped.length === 0)
            return { ok: true, alreadyClosed: true, deducted: 0, skipped: 0 };

          const pays = (input.payments ?? []).filter((p) => p.amount > 0);
          if (pays.length)
            await tx
              .insert(orderPayments)
              .values(pays.map((p) => ({ orderId: input.id, ...p })));

          // Carcass meat balances (meat is tracked at carcass, not cut, level).
          const carc = await tx
            .select({ id: products.id, name: products.name })
            .from(products)
            .where(inArray(products.name, ["Мол лаҳм", "Қўй лаҳм"]))
            .orderBy(products.createdAt);
          const molId = carc.find((c) => c.name === "Мол лаҳм")?.id ?? null;
          const qoyId = carc.find((c) => c.name === "Қўй лаҳм")?.id ?? null;

          // product type/unit lookup — only deduct stock-leaf, non-dona components (in grams)
          const prodMap = new Map(
            (
              await tx
                .select({
                  id: products.id,
                  type: products.type,
                  unit: products.unit,
                })
                .from(products)
            ).map((p) => [p.id, p]),
          );

          const items = await tx
            .select({
              productId: orderItems.productId,
              name: orderItems.name,
              qty: orderItems.qty,
              ptype: products.type,
              punit: products.unit,
              soldByWeight: products.soldByWeight,
            })
            .from(orderItems)
            .leftJoin(products, eq(orderItems.productId, products.id))
            .where(eq(orderItems.orderId, input.id));

          const moves: (typeof stockMovements.$inferInsert)[] = [];
          const skippedNames = new Set<string>();

          for (const it of items) {
            if (!it.productId) {
              skippedNames.add(it.name);
              continue;
            }
            if (it.ptype === "goods") {
              // goods are sold per piece; only deduct dona-unit goods (native count)
              if (it.punit === "dona")
                moves.push({
                  productId: it.productId,
                  type: "sale_writeoff",
                  qty: -it.qty,
                  unit: "dona",
                  refType: "order",
                  refId: input.id,
                  createdById: ctx.user.id,
                });
              else skippedNames.add(it.name);
              continue;
            }
            if (it.soldByWeight) {
              skippedNames.add(it.name);
              continue;
            }
            const rec = (
              await tx
                .select({ id: recipes.id })
                .from(recipes)
                .where(eq(recipes.productId, it.productId))
                .limit(1)
            )[0];
            if (!rec) {
              skippedNames.add(it.name);
              continue;
            }
            const ris = await tx
              .select()
              .from(recipeItems)
              .where(eq(recipeItems.recipeId, rec.id));
            for (const ri of ris) {
              if (ri.qtyG == null) continue;
              const hint = ri.stockHint ?? "";
              let target: string | null = null;
              if (/обвалка|лаҳм/i.test(hint)) {
                // carcass meat → grams against the 2 carcass products
                target = /мол/i.test(hint)
                  ? molId
                  : /қўй|қуй|куй/i.test(hint)
                    ? qoyId
                    : null;
              } else if (ri.componentId) {
                // mapped ingredient: only a stock-leaf, weight-unit product (grams)
                const c = prodMap.get(ri.componentId);
                if (c && c.type !== "dish" && c.type !== "semi" && c.unit !== "dona")
                  target = ri.componentId;
              }

              if (target)
                moves.push({
                  productId: target,
                  type: "sale_writeoff",
                  qty: -(ri.qtyG * it.qty),
                  unit: "g",
                  refType: "order",
                  refId: input.id,
                  note: ri.componentName,
                  createdById: ctx.user.id,
                });
              else skippedNames.add(ri.componentName);
            }
          }

          if (moves.length) await tx.insert(stockMovements).values(moves);
          return {
            ok: true,
            deducted: moves.length,
            skipped: skippedNames.size,
            skippedNames: [...skippedNames].slice(0, 12),
          };
        });
      }),
  }),

  stock: router({
    onHand: protectedProcedure.query(async () => {
      const rows = await db
        .select({
          productId: stockMovements.productId,
          name: products.name,
          type: products.type,
          unit: products.unit,
          onHand: sql<number>`sum(${stockMovements.qty})`,
        })
        .from(stockMovements)
        .innerJoin(products, eq(stockMovements.productId, products.id))
        .groupBy(
          stockMovements.productId,
          products.name,
          products.type,
          products.unit,
        )
        .orderBy(products.type, products.name);
      return rows.map((r) => ({ ...r, onHand: Number(r.onHand) }));
    }),
  }),

  purchase: router({
    // Purchasable goods/raw — meat comes via obvalka, dishes/semi are produced.
    products: protectedProcedure.query(async () => {
      return db
        .select({
          id: products.id,
          name: products.name,
          unit: products.unit,
          type: products.type,
          costPrice: products.costPrice,
        })
        .from(products)
        .where(
          and(
            eq(products.active, true),
            inArray(products.type, ["ingredient", "goods"]),
          ),
        )
        .orderBy(products.name);
    }),

    list: protectedProcedure.query(async () => {
      const rows = await db
        .select({
          id: purchases.id,
          supplier: purchases.supplier,
          total: purchases.total,
          createdAt: purchases.createdAt,
          buyer: users.name,
          lines: sql<number>`count(${purchaseItems.id})`,
        })
        .from(purchases)
        .leftJoin(users, eq(purchases.createdById, users.id))
        .leftJoin(purchaseItems, eq(purchaseItems.purchaseId, purchases.id))
        .groupBy(purchases.id, users.name)
        .orderBy(desc(purchases.createdAt))
        .limit(50);
      return rows.map((r) => ({ ...r, lines: Number(r.lines) }));
    }),

    create: protectedProcedure
      .input(
        z.object({
          supplier: z.string().optional(),
          note: z.string().optional(),
          items: z
            .array(
              z.object({
                productId: z.string().uuid(),
                qty: z.number().positive(),
                price: z.number().int().nonnegative(),
              }),
            )
            .min(1),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        return db.transaction(async (tx) => {
          const prods = await tx
            .select({ id: products.id, unit: products.unit })
            .from(products)
            .where(
              inArray(
                products.id,
                input.items.map((i) => i.productId),
              ),
            );
          const unitOf = new Map(prods.map((p) => [p.id, p.unit]));

          // build persisted lines first so `total` matches only what's recorded
          const draft: {
            productId: string;
            qty: number;
            unit: "g" | "ml" | "dona";
            price: number;
          }[] = [];
          let total = 0;
          for (const it of input.items) {
            const u = unitOf.get(it.productId);
            if (!u) continue;
            const factor = u === "kg" || u === "l" ? 1000 : 1;
            const base = Math.round(it.qty * factor);
            if (base <= 0) continue;
            const baseUnit =
              u === "dona" ? "dona" : u === "l" || u === "ml" ? "ml" : "g";
            total += it.price;
            draft.push({ productId: it.productId, qty: base, unit: baseUnit, price: it.price });
            // remember last purchase price per display unit (kg/dona/l)
            const perUnit = Math.round(it.price / it.qty);
            if (perUnit > 0)
              await tx
                .update(products)
                .set({ costPrice: perUnit })
                .where(eq(products.id, it.productId));
          }
          if (!draft.length)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Маҳсулот танланг",
            });

          const head = (
            await tx
              .insert(purchases)
              .values({
                supplier: input.supplier ?? null,
                note: input.note ?? null,
                total,
                createdById: ctx.user.id,
              })
              .returning()
          )[0];
          if (!head) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

          await tx.insert(purchaseItems).values(
            draft.map((l) => ({
              purchaseId: head.id,
              productId: l.productId,
              qty: l.qty,
              unit: l.unit,
              price: l.price,
            })),
          );
          await tx.insert(stockMovements).values(
            draft.map((l) => ({
              productId: l.productId,
              type: "purchase" as const,
              qty: l.qty,
              unit: l.unit,
              refType: "purchase",
              refId: head.id,
              createdById: ctx.user.id,
            })),
          );
          return { id: head.id, lines: draft.length, total };
        });
      }),
  }),

  finance: router({
    expenses: router({
      list: directorProcedure
        .input(
          z
            .object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
            .optional(),
        )
        .query(async ({ input }) => {
          const { startUTC, endUTC, dayKey } = businessDayBounds(input?.day);
          const rows = await db
            .select({
              id: expenses.id,
              category: expenses.category,
              amount: expenses.amount,
              method: expenses.method,
              recurring: expenses.recurring,
              note: expenses.note,
              spentAt: expenses.spentAt,
            })
            .from(expenses)
            .where(
              and(gte(expenses.spentAt, startUTC), lt(expenses.spentAt, endUTC)),
            )
            .orderBy(desc(expenses.spentAt));
          const total = rows.reduce((s, r) => s + r.amount, 0);
          const byCat: Record<string, number> = {};
          for (const r of rows) byCat[r.category] = (byCat[r.category] ?? 0) + r.amount;
          return { dayKey, rows, total, byCat };
        }),

      create: directorProcedure
        .input(
          z.object({
            category: z.enum(["ijara", "gaz", "elektr", "ish_haqi", "jihoz", "boshqa"]),
            amount: z.number().int().positive(),
            method: z.enum(["cash", "card", "click", "payme", "debt"]).optional(),
            recurring: z.boolean().optional(),
            note: z.string().optional(),
            day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          }),
        )
        .mutation(async ({ input, ctx }) => {
          // backdate to noon of the chosen business day (lands inside its 06:00 window)
          const spentAt = input.day
            ? new Date(businessDayBounds(input.day).startUTC.getTime() + 12 * 3600 * 1000)
            : new Date();
          const row = (
            await db
              .insert(expenses)
              .values({
                category: input.category,
                amount: input.amount,
                method: input.method ?? "cash",
                recurring: input.recurring ?? false,
                note: input.note ?? null,
                spentAt,
                createdById: ctx.user.id,
              })
              .returning({ id: expenses.id })
          )[0];
          return { id: row?.id };
        }),

      delete: directorProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ input }) => {
          await db.delete(expenses).where(eq(expenses.id, input.id));
          return { ok: true };
        }),
    }),

    dayClose: directorProcedure
      .input(
        z
          .object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
          .optional(),
      )
      .query(async ({ input }) => {
        const { startUTC, endUTC, dayKey } = businessDayBounds(input?.day);
        const fin = await financeForWindow(startUTC, endUTC);
        return { dayKey, ...fin };
      }),

    pnl: directorProcedure
      .input(
        z.object({
          from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .query(async ({ input }) => {
        const { startUTC, endUTC, days } = businessRangeBounds(input.from, input.to);
        const fin = await financeForWindow(startUTC, endUTC);
        const cogsShare = fin.revenue > 0 ? fin.cogs / fin.revenue : 0;
        const denom = 1 - cogsShare;
        return {
          ...fin,
          days,
          dailyAvg: Math.round(fin.revenue / days),
          marginPct: fin.revenue > 0 ? Math.round((fin.sofFoyda / fin.revenue) * 100) : null,
          breakEvenPerDay: denom > 0 ? Math.round(fin.opex / days / denom) : null,
        };
      }),

    debts: directorProcedure.query(async () => {
      const supplierRows = await db
        .select({
          id: purchases.id,
          supplier: purchases.supplier,
          total: purchases.total,
          paidTotal: purchases.paidTotal,
          createdAt: purchases.createdAt,
        })
        .from(purchases)
        .where(sql`${purchases.paidTotal} < ${purchases.total}`)
        .orderBy(desc(purchases.createdAt));
      const supplier = supplierRows.map((r) => ({
        ...r,
        outstanding: r.total - r.paidTotal,
      }));
      const supplierTotal = supplier.reduce((s, r) => s + r.outstanding, 0);

      const guestRows = await db
        .select({
          orderId: orders.id,
          tableNo: orders.tableNo,
          closedAt: orders.closedAt,
          hall: halls.name,
          amount: orderPayments.amount,
        })
        .from(orderPayments)
        .innerJoin(orders, eq(orderPayments.orderId, orders.id))
        .leftJoin(halls, eq(orders.hallId, halls.id))
        .where(eq(orderPayments.method, "debt"))
        .orderBy(desc(orders.closedAt))
        .limit(50);
      // total is unbounded — guestRows is only the latest 50 for display
      const guestTotal = Number(
        (
          await db
            .select({
              s: sql<number>`coalesce(sum(${orderPayments.amount}), 0)`,
            })
            .from(orderPayments)
            .where(eq(orderPayments.method, "debt"))
        )[0]?.s ?? 0,
      );

      return { supplier, supplierTotal, guest: guestRows, guestTotal };
    }),

    paySupplier: protectedProcedure
      .input(
        z.object({
          purchaseId: z.string().uuid(),
          amount: z.number().int().positive(),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        if (!["director", "manager", "buyer"].includes(ctx.user.role))
          throw new TRPCError({ code: "FORBIDDEN" });
        return db.transaction(async (tx) => {
          const p = (
            await tx
              .select({ total: purchases.total, paidTotal: purchases.paidTotal })
              .from(purchases)
              .where(eq(purchases.id, input.purchaseId))
              .limit(1)
          )[0];
          if (!p) throw new TRPCError({ code: "NOT_FOUND" });
          const outstanding = p.total - p.paidTotal;
          if (input.amount > outstanding)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `Қолган қарз ${outstanding.toLocaleString("ru-RU")} so'm`,
            });
          // atomic + guarded: bump in SQL, reject if a concurrent payment would
          // push paidTotal over total (lost-update / over-pay protection)
          const updated = await tx
            .update(purchases)
            .set({ paidTotal: sql`${purchases.paidTotal} + ${input.amount}` })
            .where(
              and(
                eq(purchases.id, input.purchaseId),
                sql`${purchases.paidTotal} + ${input.amount} <= ${purchases.total}`,
              ),
            )
            .returning({ paidTotal: purchases.paidTotal });
          if (updated.length === 0)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Қарз ўзгарган — қайта уриниб кўринг",
            });
          return { ok: true, paidTotal: updated[0]!.paidTotal };
        });
      }),
  }),
});

export type AppRouter = typeof appRouter;
