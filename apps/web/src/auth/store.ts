import { create } from "zustand";

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  permissions: string[];
  scopeAll: boolean;
  mfa: boolean;
  locale: "es" | "en" | "ca";
};

type AuthState = {
  status: "loading" | "anonymous" | "authenticated";
  mode: "otp" | "oidc";
  user: AuthUser | null;
  setUser: (user: AuthUser | null) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  status: "loading",
  mode: "otp",
  user: null,
  setUser: (user) => set({ user, status: user ? "authenticated" : "anonymous" }),
}));

/** Whether the signed-in user holds a permission (`system:admin` holds all). */
export function useCan() {
  const permissions = useAuthStore((s) => s.user?.permissions);
  return (permission: string) => Boolean(permissions && (permissions.includes("system:admin") || permissions.includes(permission)));
}

async function json(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function loadSession() {
  try {
    const config = await json(await fetch("/api/v1/auth/config"));
    if (config.mode === "oidc" || config.mode === "otp") useAuthStore.setState({ mode: config.mode });
    const response = await fetch("/api/v1/auth/me", { credentials: "same-origin" });
    if (!response.ok) return useAuthStore.getState().setUser(null);
    useAuthStore.getState().setUser((await json(response)).user as AuthUser);
  } catch {
    useAuthStore.getState().setUser(null);
  }
}

export async function requestOtp(email: string) {
  const response = await fetch("/api/v1/auth/request-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
  if (!response.ok) throw new Error((await json(response)).error ?? "error");
}

export async function verifyOtp(email: string, code: string) {
  const response = await fetch("/api/v1/auth/verify-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code }) });
  if (!response.ok) throw new Error((await json(response)).error ?? "error");
  await loadSession();
}

export const startOidc = () => {
  window.location.href = `/api/v1/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
};

export async function logout() {
  // Drop the service-worker cache so the next person on this device never sees cached data.
  if (typeof caches !== "undefined") await caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).catch(() => undefined);
  const out = await json(await fetch("/api/v1/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => new Response("{}")));
  useAuthStore.getState().setUser(null);
  if (typeof out.redirect === "string") window.location.href = out.redirect;
}
