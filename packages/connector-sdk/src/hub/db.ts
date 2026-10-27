/** The only database surface the hub needs; `pg.Pool`, a transaction client and the `Tx` of @orchestrador/db all satisfy it. */
export type Db = {
  query<R extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
};
