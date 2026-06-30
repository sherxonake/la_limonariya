import { useEffect, useState } from "react";
import { trpc } from "./trpc";

type Row = {
  productId: string;
  name: string;
  type: string;
  unit: string;
  onHand: number;
};

const TYPE_LABEL: Record<string, string> = {
  part: "Гўшт",
  ingredient: "Хом-ашё",
  goods: "Товар",
  semi: "Ярим-т.",
  dish: "Таом",
};

function fmt(r: Row): string {
  if (r.unit === "dona") return `${r.onHand} дона`;
  return Math.abs(r.onHand) >= 1000
    ? `${(r.onHand / 1000).toFixed(2)} кг`
    : `${r.onHand} г`;
}

export function Ombor() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    trpc.stock.onHand
      .query()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  if (!rows) return <div className="p-6 text-center text-zinc-400">⏳</div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        Қолдиқ ҳаракатлардан ҳисобланади (обвалка кирим − сотув чиқим). Боғланмаган
        ингредиентлар ҳисобланмайди.
      </p>
      <div className="overflow-hidden rounded-xl border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Маҳсулот</th>
              <th className="px-3 py-2 font-medium">Тур</th>
              <th className="px-4 py-2 text-right font-medium">Қолдиқ</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.productId}>
                <td className="px-4 py-2">{r.name}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">
                  {TYPE_LABEL[r.type] ?? r.type}
                </td>
                <td
                  className={`px-4 py-2 text-right font-medium tabular-nums ${
                    r.onHand < 0 ? "text-red-500" : "text-zinc-700"
                  }`}
                >
                  {fmt(r)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-zinc-400">
            Ҳали ҳаракат йўқ — обвалка ёзинг ёки заказ ёпинг
          </div>
        )}
      </div>
    </div>
  );
}
