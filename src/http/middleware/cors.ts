import cors, { type CorsOptions } from "cors";

import { env } from "../../config/env.js";

const corsOptions = {
  origin: env.FRONTEND_ORIGIN,
  credentials: true,
  allowedHeaders: ["authorization", "content-type", "x-request-id"],
  exposedHeaders: ["x-request-id"],
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
} satisfies CorsOptions;

export const corsMiddleware = cors(corsOptions);
