import { useCallback, useEffect, useState } from "react";
import { Login } from "./Login";
import { Shell } from "./Shell";
import { trpc } from "./trpc";

export type SessionUser = { id: string; name: string; role: string };

export function App() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setUser(await trpc.auth.me.query());
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  if (loading) {
    return (
      <main className="grid min-h-dvh place-items-center bg-zinc-900 text-zinc-500">
        ⏳
      </main>
    );
  }
  if (!user) return <Login onSuccess={setUser} />;
  return <Shell user={user} onLogout={() => setUser(null)} />;
}
