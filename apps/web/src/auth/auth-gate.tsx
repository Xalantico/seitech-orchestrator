import { useEffect, type ReactNode } from "react";

import { useT } from "../lib/i18n";
import { LoginScreen } from "./login-screen";
import { loadSession, useAuthStore } from "./store";

export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const t = useT();
  useEffect(() => {
    void loadSession();
  }, []);
  if (status === "loading") return <div className="login-wrap"><div className="login-card">{t("common.loading")}</div></div>;
  if (status === "anonymous") return <LoginScreen />;
  return <>{children}</>;
}
