import { useSyncExternalStore } from "react";

const NAV_EVENT = "orq:navigate";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(NAV_EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(NAV_EVENT, listener);
  };
}

export const usePathname = () => useSyncExternalStore(subscribe, () => window.location.pathname);
export const useSearch = () => useSyncExternalStore(subscribe, () => window.location.search);

export function navigate(path: string) {
  if (window.location.pathname + window.location.search === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** `/flows/:id/:version?` against `/flows/abc/2` → `{ id: "abc", version: "2" }`; null when it does not match. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const have = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    const optional = part.endsWith("?");
    const name = part.replace(/\?$/, "");
    if (name.startsWith(":")) {
      const value = have[i];
      if (value === undefined) {
        if (optional) continue;
        return null;
      }
      params[name.slice(1)] = decodeURIComponent(value);
    } else if (have[i] !== name) return null;
  }
  return have.length > want.length ? null : params;
}
