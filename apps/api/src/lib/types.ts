import type { Principal } from "./principal.js";

export type AppEnv = {
  Variables: {
    principal: Principal;
    requestId: string;
    ip: string;
    sessionId?: string;
  };
};
