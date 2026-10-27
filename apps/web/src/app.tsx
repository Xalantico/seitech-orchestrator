import { useEffect } from "react";

import { AuthGate } from "./auth/auth-gate";
import { useCan } from "./auth/store";
import { useT } from "./lib/i18n";
import { AdminPage } from "./pages/admin";
import { MessagesPage, TemplatesPage } from "./pages/comms";
import { AlertsPage, ExportsPage } from "./pages/control";
import { DashboardPage } from "./pages/dashboard";
import { ExecutionsPage } from "./pages/executions";
import { ExplorerPage } from "./pages/explorer";
import { BiPage, CopilotPage } from "./pages/extras";
import { FlowEditorPage } from "./pages/flow-editor";
import { FlowsPage } from "./pages/flows";
import { FormsPage } from "./pages/forms";
import { GovernancePage } from "./pages/governance";
import { IntegrationsPage } from "./pages/integrations";
import { MappingsPage } from "./pages/mappings";
import { TasksPage } from "./pages/tasks";
import { matchPath, navigate, usePathname } from "./route";
import { Shell, NAV } from "./shell";

type Route = { pattern: string; perm: string; element: () => React.ReactNode; flush?: boolean };

const ROUTES: Route[] = [
  { pattern: "/", perm: "dashboard:read", element: DashboardPage },
  { pattern: "/explorer/:entity?", perm: "work_orders:read", element: ExplorerPage },
  { pattern: "/tasks", perm: "tasks:read", element: TasksPage },
  { pattern: "/forms", perm: "forms:read", element: FormsPage },
  { pattern: "/flows", perm: "flows:read", element: FlowsPage },
  { pattern: "/flows/:id/:version?", perm: "flows:read", element: FlowEditorPage, flush: true },
  { pattern: "/executions/:id?", perm: "executions:read", element: ExecutionsPage },
  { pattern: "/templates", perm: "templates:read", element: TemplatesPage },
  { pattern: "/messages", perm: "messages:read", element: MessagesPage },
  { pattern: "/integrations", perm: "connectors:read", element: IntegrationsPage },
  { pattern: "/mappings", perm: "mappings:read", element: MappingsPage },
  { pattern: "/alerts", perm: "alerts:read", element: AlertsPage },
  { pattern: "/exports", perm: "exports:run", element: ExportsPage },
  { pattern: "/bi", perm: "bi:read", element: BiPage },
  { pattern: "/copilot", perm: "copilot:use", element: CopilotPage },
  { pattern: "/governance", perm: "audit:read", element: GovernancePage },
  { pattern: "/admin", perm: "users:read", element: AdminPage },
];

function Routes() {
  const path = usePathname();
  const can = useCan();
  const t = useT();
  const hit = ROUTES.map((r) => ({ r, params: matchPath(r.pattern, path) })).find((x) => x.params);

  // Land on the first section the person may use when "/" is not theirs.
  const home = NAV.find((n) => can(n.perm));
  useEffect(() => {
    if (path === "/" && !can("dashboard:read") && home) navigate(home.path);
  }, [path, home, can]);

  if (!hit) return <Shell><div className="muted pad">404</div></Shell>;
  const Page = hit.r.element;
  return <Shell flush={hit.r.flush}>{can(hit.r.perm) ? <Page /> : <div className="note note-warn">{t("common.noAccess")}</div>}</Shell>;
}

export function App() {
  return (
    <AuthGate>
      <Routes />
    </AuthGate>
  );
}
