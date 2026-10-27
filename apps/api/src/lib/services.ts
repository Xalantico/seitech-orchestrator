import { createLogger, type Logger } from "@orchestrador/observability";
import { createMailer, createObjectStore, createRateLimiter, createRedis } from "@orchestrador/platform";

import { env } from "../env.js";

export const log: Logger = createLogger("api", env.LOG_LEVEL);
export const redis = createRedis(env.REDIS_URL);
redis?.on("error", (error) => log.warn({ err: error.message }, "redis error"));
export const rateLimit = createRateLimiter(redis);
export const mailer = createMailer(
  { smtpUrl: env.SMTP_URL, postmarkToken: env.POSTMARK_SERVER_TOKEN, from: env.MAIL_FROM },
  log,
);
export const store = createObjectStore({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
});
