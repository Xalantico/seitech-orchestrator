import type { Logger } from "@orchestrador/observability";
import type { Client } from "@temporalio/client";
import type pg from "pg";

export type Tx = pg.PoolClient;

export type FlowHostDeps = {
  pool: pg.Pool;
  /** Runs `fn` in a system-level transaction (no data scope, audit label set by the caller). */
  system: <T>(fn: (db: Tx) => Promise<T>) => Promise<T>;
  log: Logger;
  temporal: () => Promise<Client>;
  /** Simulation client (own namespace when configured). */
  simTemporal: () => Promise<Client>;
  namespace: string;
  simNamespace?: string | undefined;
  uiOrigin: string;
  isProd: boolean;
  /** Counter hook so the host stays free of metric registries. */
  onStarted?: (trigger: string) => void;
};
