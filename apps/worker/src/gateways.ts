import { createGateways } from "@orchestrador/connectors";
import { createObjectStore } from "@orchestrador/platform";

import { env } from "./env.js";
import { log, pool } from "./services.js";

const store = createObjectStore({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY });

export const { documents: documentGateway, objects: objectGateway } = createGateways({ pool, store, bucket: env.S3_BUCKET_DOCUMENTS, log });
