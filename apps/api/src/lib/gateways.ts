import { createGateways } from "@orchestrador/connectors";

import { env } from "../env.js";
import { pool } from "./db.js";
import { log, store } from "./services.js";

/** Documents and raw objects as connectors and background jobs see them (same implementation the worker uses). */
export const gateways = createGateways({ pool, store, bucket: env.S3_BUCKET_DOCUMENTS, log, maxBytes: env.MAX_UPLOAD_BYTES });
