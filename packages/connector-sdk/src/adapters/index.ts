import { registerAdapter } from "../adapter.js";
import { genericHttpAdapter } from "./generic-http.js";
import { mockAdapter } from "./mock.js";

export { genericHttpAdapter, mockAdapter };
export { resetMockAdapter } from "./mock.js";

/** Adapters shipped with the SDK. System-specific adapters live in @orchestrador/connectors. */
export function registerBuiltinAdapters(): void {
  registerAdapter(genericHttpAdapter);
  registerAdapter(mockAdapter);
}
