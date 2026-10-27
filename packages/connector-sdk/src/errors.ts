/** Failure of an external call. `retryable` decides between outbox backoff and a dead letter + back-office task. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly details: { status?: number; body?: unknown; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const transient = (code: string, message: string, details?: ConnectorError["details"]) => new ConnectorError(message, code, true, details);
export const permanent = (code: string, message: string, details?: ConnectorError["details"]) => new ConnectorError(message, code, false, details);

/** Exponential backoff with jitter: 5s, 10s, 20s ... capped at 30 minutes. `random` is injectable for tests. */
export function backoffMs(attempt: number, opts: { baseMs?: number; factor?: number; maxMs?: number; jitter?: number; random?: () => number } = {}): number {
  const { baseMs = 5000, factor = 2, maxMs = 30 * 60_000, jitter = 0.2, random = Math.random } = opts;
  const raw = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt - 1));
  return Math.round(raw * (1 - jitter + random() * jitter * 2));
}
