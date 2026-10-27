import { useEffect, useState, type ReactNode } from "react";

import { logout, useAuthStore, useCan } from "./auth/store";
import { LOCALES, useLocale, useT, type Key, type Locale } from "./lib/i18n";
import { Btn, Toasts } from "./lib/ui";
import { navigate, usePathname } from "./route";

export type NavItem = { path: string; label: Key; perm: string; group: Key };

export const NAV: NavItem[] = [
  { path: "/", label: "nav.dashboard", perm: "dashboard:read", group: "nav.group.operations" },
  { path: "/explorer", label: "nav.explorer", perm: "work_orders:read", group: "nav.group.operations" },
  { path: "/tasks", label: "nav.tasks", perm: "tasks:read", group: "nav.group.operations" },
  { path: "/forms", label: "nav.forms", perm: "forms:read", group: "nav.group.operations" },
  { path: "/flows", label: "nav.flows", perm: "flows:read", group: "nav.group.automation" },
  { path: "/executions", label: "nav.executions", perm: "executions:read", group: "nav.group.automation" },
  { path: "/templates", label: "nav.templates", perm: "templates:read", group: "nav.group.communication" },
  { path: "/messages", label: "nav.messages", perm: "messages:read", group: "nav.group.communication" },
  { path: "/integrations", label: "nav.integrations", perm: "connectors:read", group: "nav.group.integration" },
  { path: "/mappings", label: "nav.mappings", perm: "mappings:read", group: "nav.group.integration" },
  { path: "/alerts", label: "nav.alerts", perm: "alerts:read", group: "nav.group.control" },
  { path: "/exports", label: "nav.exports", perm: "exports:run", group: "nav.group.control" },
  { path: "/bi", label: "nav.bi", perm: "bi:read", group: "nav.group.control" },
  { path: "/copilot", label: "nav.copilot", perm: "copilot:use", group: "nav.group.control" },
  { path: "/governance", label: "nav.governance", perm: "audit:read", group: "nav.group.control" },
  { path: "/admin", label: "nav.admin", perm: "users:read", group: "nav.group.control" },
];

const isActive = (path: string, current: string) => (path === "/" ? current === "/" : current === path || current.startsWith(`${path}/`));

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

type InstallPrompt = Event & { prompt: () => Promise<void> };

export function Shell({ children, flush }: { children: ReactNode; flush?: boolean }) {
  const t = useT();
  const can = useCan();
  const user = useAuthStore((s) => s.user);
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const online = useOnline();
  const { locale, set: setLocale } = useLocale();
  const [theme, setTheme] = useState(() => localStorage.getItem("orq.theme") ?? "light");
  const [install, setInstall] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("orq.theme", theme);
  }, [theme]);
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstall(e as InstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);
  useEffect(() => setOpen(false), [path]);

  const items = NAV.filter((n) => can(n.perm));
  const groups = [...new Set(items.map((n) => n.group))];

  return (
    <div className="shell">
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Navegación">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="3" cy="8" r="2" fill="#fff" /><circle cx="13" cy="3" r="2" fill="#fff" /><circle cx="13" cy="13" r="2" fill="#fff" /><path d="M5 8h3c2 0 2-5 5-5M8 8c2 0 2 5 5 5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </span>
          {t("app.name")}
        </div>
        <nav className="nav">
          {groups.map((g) => (
            <div key={g} style={{ display: "contents" }}>
              <div className="nav-group">{t(g)}</div>
              {items.filter((n) => n.group === g).map((n) => (
                <a key={n.path} href={n.path} className={isActive(n.path, path) ? "is-active" : ""} aria-current={isActive(n.path, path) ? "page" : undefined}
                  onClick={(e) => { e.preventDefault(); navigate(n.path); }}>{t(n.label)}</a>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <header className="topbar">
        <Btn className="burger" variant="ghost" aria-label="Menu" onClick={() => setOpen((o) => !o)}>☰</Btn>
        <div className="grow" />
        {install ? <Btn small onClick={() => void install.prompt()}>{t("shell.install")}</Btn> : null}
        <select className="mini" aria-label={t("shell.language")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
          {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
        </select>
        <Btn small variant="ghost" aria-label={t("shell.theme")} title={t("shell.theme")} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</Btn>
        {user ? (
          <div className="user-chip">
            <span className="avatar" aria-hidden="true">{user.displayName.charAt(0)}</span>
            <span className="email small">{user.email}</span>
            <Btn small variant="ghost" onClick={() => void logout()}>{t("shell.signOut")}</Btn>
          </div>
        ) : null}
      </header>
      <main className={`main${flush ? " flush" : ""}`}>
        {!online ? <div className="offline" role="alert">{t("shell.offline")}</div> : null}
        {children}
      </main>
      <Toasts />
    </div>
  );
}
