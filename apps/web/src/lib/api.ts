import { useAuthStore } from "../auth/store";

const BASE = "/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

export type Json = Record<string, unknown>;

export async function api<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) useAuthStore.getState().setUser(null);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!response.ok) {
    const e = (parsed ?? {}) as { error?: string | { message?: string }; code?: string; issues?: unknown; details?: unknown };
    const message = typeof e.error === "string" ? e.error : e.error?.message ?? `Error ${response.status}`;
    throw new ApiError(message, response.status, e.code ?? "error", e.issues ?? e.details);
  }
  return parsed as T;
}

export const get = <T = Json>(path: string, params?: Record<string, string | number | boolean | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return api<T>("GET", s ? `${path}?${s}` : path);
};
export const post = <T = Json>(path: string, body: unknown = {}) => api<T>("POST", path, body);
export const put = <T = Json>(path: string, body: unknown) => api<T>("PUT", path, body);
export const patch = <T = Json>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const del = <T = Json>(path: string) => api<T>("DELETE", path);

/** Opens a file endpoint in a new tab (the session cookie authorises it). */
export const download = (path: string) => window.open(`${BASE}${path}`, "_blank", "noopener");
