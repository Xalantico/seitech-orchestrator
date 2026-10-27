import { registerAdapter, registerBuiltinAdapters, type Adapter } from "@orchestrador/connector-sdk";

import { businessCentralAdapter } from "./adapters/business-central.js";
import { caeAdapter } from "./adapters/cae.js";
import { commsManagerAdapter } from "./adapters/comms-manager.js";
import { dmsAdapter } from "./adapters/dms.js";
import { esignAdapter } from "./adapters/esign.js";
import { euroconectAdapter } from "./adapters/euroconect.js";
import { eurocertAdapter } from "./adapters/eurocert.js";
import { fsmFieldAdapter } from "./adapters/fsm-field.js";
import { fsmFormsAdapter } from "./adapters/fsm-forms.js";
import { fsmPlannerAdapter } from "./adapters/fsm-planner.js";
import { hubspotAdapter } from "./adapters/hubspot.js";
import { m365Adapter } from "./adapters/m365.js";
import { navisionAdapter } from "./adapters/navision.js";
import { portalAdapter } from "./adapters/portal.js";
import { sqlServerAdapter } from "./adapters/sqlserver.js";
import { taskAdapter } from "./adapters/task.js";

export * from "./adapters/dms.js";
export * from "./adapters/sqlserver.js";
export * from "./defaults.js";
export * from "./gateways.js";
export * from "./domain.js";
export * from "./rest.js";
export * from "./seed.js";
export { businessCentralAdapter, caeAdapter, commsManagerAdapter, dmsAdapter, esignAdapter, euroconectAdapter, eurocertAdapter, fsmFieldAdapter, fsmFormsAdapter, fsmPlannerAdapter, hubspotAdapter, m365Adapter, navisionAdapter, portalAdapter, sqlServerAdapter, taskAdapter };

export const ALL_ADAPTERS: Adapter[] = [
  hubspotAdapter, businessCentralAdapter, navisionAdapter, fsmPlannerAdapter, fsmFieldAdapter, taskAdapter, euroconectAdapter, eurocertAdapter,
  fsmFormsAdapter, esignAdapter, commsManagerAdapter, dmsAdapter, caeAdapter, portalAdapter, m365Adapter, sqlServerAdapter,
];

/** Registers the generic and mock adapters of the SDK plus every system adapter. Call once at start-up. */
export function registerAllAdapters(): void {
  registerBuiltinAdapters();
  for (const a of ALL_ADAPTERS) registerAdapter(a);
}
