import { createProviders, dispatchMessages } from "@orchestrador/comms";
import { metrics } from "@orchestrador/observability";
import { createMailer } from "@orchestrador/platform";

import { env } from "./env.js";
import { log, pool, sys } from "./services.js";

const mailer = createMailer({ smtpUrl: env.SMTP_URL, postmarkToken: env.POSTMARK_SERVER_TOKEN, from: env.MAIL_FROM }, log);

/** One pass of the message dispatcher; the loop keeps calling while there is backlog (1000-message bursts drain in seconds). */
export const sendQueuedMessages = (batch = 200) =>
  dispatchMessages(
    {
      pool,
      system: (fn) => sys(fn, "message-dispatcher"),
      providers: createProviders({ mailer }),
      log,
      defaultEmailProvider: env.SMTP_URL || env.POSTMARK_SERVER_TOKEN ? "smtp" : "mock",
      concurrency: env.MESSAGE_CONCURRENCY,
      onSent: (channel) => metrics.messagesSent.inc({ channel, result: "sent" }),
      onFailed: (channel) => metrics.messagesSent.inc({ channel, result: "failed" }),
    },
    batch,
  );
