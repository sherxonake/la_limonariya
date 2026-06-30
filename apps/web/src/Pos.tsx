import { useCallback, useEffect, useState } from "react";
import { trpc } from "./trpc";

type Hall = { id: string; name: string; servicePct: number };
type MenuItem = {
  id: string;
  name: string;
  price: number;
  category: string | null;
};
type OpenOrder = {
  id: string;
  tableNo: string | null;
  hall: string | null;
  waiter: string | null;
  qty: number;
  total: number;
};
type Order = {
  id: string;
  tableNo: string | null;
  status: string;
  servicePct: number;
  hall: string | null;
  waiter: string | null;
  items: {
    id: string;
    productId: string | null;
    name: string;
    price: number;
    qty: number;
  }[];
  subtotal: number;
  service: number;
  total: number;
};

const fmt = (n: number) => n.toLocaleString("ru-RU");

export function Pos() {
  const [orderId, setOrderId] = useState<string | null>(null);
  if (orderId)
    return <OrderView id={orderId} onBack={() => setOrderId(null)} />;
  return <OrderList onOpen={setOrderId} onNew={setOrderId} />;
}

function OrderList({
  onOpen,
  onNew,
}: {
  onOpen: (id: string) => void;
  onNew: (id: string) => void;
}) {
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [halls, setHalls] = useState<Hall[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    trpc.pos.openOrders.query().then(setOrders).catch(() => setOrders([]));
    trpc.pos.halls.query().then(setHalls).catch(() => {});
  }, []);

  async function create(hallId: string, tableNo: string) {
    const { id } = await trpc.pos.create.mutate({
      hallId,
      tableNo: tableNo || undefined,
    });
    onNew(id);
  }

  return (
    <div className="space-y-4">
      <button
        onClick={() => setCreating((v) => !v)}
        className="w-full rounded-xl bg-green-600 py-3 font-medium text-white"
      >
        ＋ Янги заказ
      </button>

      {creating && <NewOrder halls={halls} onCreate={create} />}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-zinc-500">
          Очиқ заказлар ({orders?.length ?? "…"})
        </h2>
        {orders && orders.length === 0 ? (
          <div className="rounded-xl border bg-white p-8 text-center text-zinc-400">
            Очиқ заказ йўқ
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {orders?.map((o) => (
              <button
                key={o.id}
                onClick={() => onOpen(o.id)}
                className="flex items-center justify-between rounded-xl border bg-white px-4 py-3 text-left hover:border-green-400"
              >
                <span>
                  <span className="font-medium">{o.hall}</span>
                  {o.tableNo && (
                    <span className="text-zinc-400"> · стол {o.tableNo}</span>
                  )}
                  <div className="text-xs text-zinc-400">
                    {o.waiter} · {o.qty} таом
                  </div>
                </span>
                <span className="font-semibold tabular-nums">{fmt(o.total)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NewOrder({
  halls,
  onCreate,
}: {
  halls: Hall[];
  onCreate: (hallId: string, tableNo: string) => void;
}) {
  const [hallId, setHallId] = useState<string | null>(null);
  const [table, setTable] = useState("");
  return (
    <div className="space-y-3 rounded-xl border bg-white p-4">
      <div className="flex flex-wrap gap-2">
        {halls.map((h) => (
          <button
            key={h.id}
            onClick={() => setHallId(h.id)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              hallId === h.id
                ? "bg-zinc-900 text-white"
                : "bg-zinc-100 text-zinc-600"
            }`}
          >
            {h.name}{" "}
            <span className="text-xs opacity-60">{h.servicePct}%</span>
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={table}
          onChange={(e) => setTable(e.target.value)}
          placeholder="Стол №"
          className="w-28 rounded-lg border px-3 py-2 text-sm outline-none focus:border-green-500"
        />
        <button
          onClick={() => hallId && onCreate(hallId, table)}
          disabled={!hallId}
          className="flex-1 rounded-lg bg-green-600 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Очиш
        </button>
      </div>
    </div>
  );
}

function OrderView({ id, onBack }: { id: string; onBack: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");

  const refresh = useCallback(() => {
    trpc.pos.order.query({ id }).then(setOrder).catch(() => {});
  }, [id]);

  useEffect(() => {
    refresh();
    trpc.pos.menu.query().then(setMenu).catch(() => {});
  }, [refresh]);

  async function add(productId: string, delta: number) {
    await trpc.pos.addItem.mutate({ orderId: id, productId, delta });
    refresh();
  }
  async function close() {
    await trpc.pos.close.mutate({ id });
    refresh();
  }

  if (!order) return <div className="p-6 text-center text-zinc-400">⏳</div>;
  const closed = order.status === "closed";
  const filtered = q
    ? menu.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
    : menu;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-zinc-500 hover:text-zinc-900">
          ← Заказлар
        </button>
        <span className="text-sm">
          <b>{order.hall}</b>
          {order.tableNo && ` · стол ${order.tableNo}`}
          {closed && <span className="ml-2 text-green-600">🧾 ёпилди</span>}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border bg-white">
        {order.items.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-zinc-400">
            Таом қўшинг
          </div>
        ) : (
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {order.items.map((it) => (
                <tr key={it.id}>
                  <td className="px-4 py-2">{it.name}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-zinc-400">
                    {fmt(it.price)}
                  </td>
                  <td className="px-2 py-2">
                    {!closed && it.productId ? (
                      <div className="flex items-center justify-center gap-2">
                        <Step onClick={() => add(it.productId!, -1)}>−</Step>
                        <span className="w-6 text-center tabular-nums">
                          {it.qty}
                        </span>
                        <Step onClick={() => add(it.productId!, 1)}>＋</Step>
                      </div>
                    ) : (
                      <span className="block text-center tabular-nums">
                        ×{it.qty}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-medium tabular-nums">
                    {fmt(it.price * it.qty)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="space-y-1 border-t bg-zinc-50 px-4 py-3 text-sm">
          <Row label="Оралиқ сумма" value={fmt(order.subtotal)} />
          <Row
            label={`Хизмат ҳақи (${order.servicePct}%)`}
            value={fmt(order.service)}
            muted
          />
          <Row label="ЖАМИ" value={`${fmt(order.total)} so'm`} big />
        </div>
      </div>

      {!closed && (
        <>
          <button
            onClick={() => setPicking((v) => !v)}
            className="w-full rounded-xl border border-dashed border-zinc-300 py-2.5 text-sm font-medium text-zinc-600"
          >
            {picking ? "Ёпиш" : "＋ Таом қўшиш"}
          </button>

          {picking && (
            <div className="overflow-hidden rounded-xl border bg-white">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Қидириш..."
                className="w-full border-b px-4 py-2 text-sm outline-none"
              />
              <div className="max-h-72 overflow-auto divide-y">
                {filtered.slice(0, 80).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => add(m.id, 1)}
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-sm hover:bg-green-50"
                  >
                    <span>{m.name}</span>
                    <span className="tabular-nums text-zinc-500">
                      {fmt(m.price)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={close}
            disabled={order.items.length === 0}
            className="w-full rounded-xl bg-zinc-900 py-3 font-medium text-white disabled:opacity-40"
          >
            Ёпиш ва чек
          </button>
        </>
      )}

      {closed && (
        <button
          onClick={onBack}
          className="w-full rounded-xl bg-green-600 py-3 font-medium text-white"
        >
          Янги заказ
        </button>
      )}
    </div>
  );
}

function Step({
  onClick,
  children,
}: {
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md bg-zinc-100 font-bold text-zinc-700 hover:bg-zinc-200"
    >
      {children}
    </button>
  );
}

function Row({
  label,
  value,
  muted,
  big,
}: {
  label: string;
  value: string;
  muted?: boolean;
  big?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${big ? "pt-1 text-base font-bold" : muted ? "text-zinc-500" : ""}`}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
