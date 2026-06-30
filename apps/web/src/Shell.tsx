import { useEffect, useState } from "react";
import type { SessionUser } from "./App";
import { trpc } from "./trpc";

const ROLE_LABEL: Record<string, string> = {
  director: "Директор",
  manager: "Менежер",
  buyer: "Бозорчи",
  cashier: "Кассир",
  waiter: "Официант",
};

type Staff = {
  id: string;
  name: string;
  role: string;
  active: boolean;
  hasPin: boolean;
};

export function Shell({
  user,
  onLogout,
}: {
  user: SessionUser;
  onLogout: () => void;
}) {
  const [staff, setStaff] = useState<Staff[] | null>(null);

  useEffect(() => {
    if (user.role === "director") {
      trpc.users.list
        .query()
        .then(setStaff)
        .catch(() => setStaff(null));
    }
  }, [user.role]);

  async function logout() {
    await trpc.auth.logout.mutate().catch(() => {});
    onLogout();
  }

  return (
    <div className="min-h-dvh bg-zinc-50 text-zinc-900">
      <header className="flex items-center justify-between border-b bg-white px-5 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold">La Limonariya</span>
          <span className="text-xs text-zinc-400">Навоий</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="font-medium">{user.name}</span>
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
            {ROLE_LABEL[user.role] ?? user.role}
          </span>
          <button onClick={logout} className="text-zinc-400 hover:text-red-500">
            Чиқиш
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-5">
        {user.role === "director" ? (
          <section>
            <h2 className="mb-3 text-sm font-semibold text-zinc-500">
              Ходимлар ({staff?.length ?? "…"})
            </h2>
            <div className="divide-y rounded-xl border bg-white">
              {staff?.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between px-4 py-2.5"
                >
                  <span>{s.name}</span>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-zinc-400">
                      {ROLE_LABEL[s.role] ?? s.role}
                    </span>
                    <span className={s.hasPin ? "text-green-600" : "text-amber-500"}>
                      {s.hasPin ? "PIN ✓" : "PIN йўқ"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="rounded-xl border bg-white p-8 text-center text-zinc-400">
            Бўлимлар тез орада (POS, омбор, обвалка...)
          </div>
        )}
      </main>
    </div>
  );
}
