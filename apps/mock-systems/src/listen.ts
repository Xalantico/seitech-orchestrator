import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

import type { createMockSystems } from "./app.js";

/** Starts the simulators on a free port (tests) or a given one. */
export async function listen(mocks: ReturnType<typeof createMockSystems>, port = 0, hostname = "127.0.0.1"): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: mocks.app.fetch, hostname, port }, (info: AddressInfo) => {
      resolve({ url: `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${info.port}`, close: () => new Promise<void>((done) => { server.close(() => done()); }) });
    });
  });
}
