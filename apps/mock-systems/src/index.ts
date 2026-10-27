import { createMockSystems } from "./app.js";
import { listen } from "./listen.js";

const mocks = createMockSystems({ token: process.env.MOCK_API_TOKEN ?? "mock-token", webhookSecret: process.env.WEBHOOK_SIGNING_SECRET ?? "mock-webhook-secret" });
const { url } = await listen(mocks, Number(process.env.PORT ?? 4010), process.env.HOST ?? "0.0.0.0");
process.stdout.write(JSON.stringify({ level: "info", service: "mock-systems", url, msg: "listening" }) + "\n");
