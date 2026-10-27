import type { Adapter } from "../adapter.js";
import { permanent, transient } from "../errors.js";

const attempts = new Map<string, number>();
export const resetMockAdapter = () => attempts.clear();

/** Deterministic adapter used by tests and the demo: echoes, fails permanently, or fails N times before succeeding. */
export const mockAdapter: Adapter = {
  kind: "mock",
  label: "Simulador",
  description: "Adaptador de pruebas: devuelve lo recibido o falla de forma controlada.",
  actions: [
    { key: "echo", label: "Eco", direction: "push", input: [{ key: "value", label: "Valor", type: "string" }], async run(ctx, input) { return { output: { echoed: input, idempotencyKey: ctx.idempotencyKey ?? null }, externalId: `mock-${String(input.value ?? "x")}` }; } },
    { key: "reject", label: "Rechazar", direction: "push", input: [], async run() { throw permanent("remote_rejected", "The remote system rejected the request"); } },
    {
      key: "flaky", label: "Falla N veces", direction: "push", input: [{ key: "failures", label: "Fallos", type: "number" }, { key: "tag", label: "Etiqueta", type: "string" }],
      async run(ctx, input) {
        const key = `${ctx.connector.key}:${String(input.tag ?? "")}`;
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        if (n <= Number(input.failures ?? 1)) throw transient("remote_unavailable", `The remote system is unavailable (call ${n})`);
        return { output: { ok: true, calls: n } };
      },
    },
  ],
  inbound: {
    ping: async (_ctx, payload) => ({ summary: `ping ${JSON.stringify(payload)}` }),
    boom: async () => { throw permanent("handler_failed", "The handler refused this event"); },
  },
  async ping() { return { ok: true, detail: "mock" }; },
  async sync(_ctx, { full }) { return { stats: { pulled: full ? 10 : 2 }, cursor: new Date(0).toISOString() }; },
};
