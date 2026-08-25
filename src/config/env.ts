import "dotenv/config";

import { z } from "zod";

import { formatZodIssues } from "../shared/validation/format-zod-issues.js";

const postgresUrlSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;

        return protocol === "postgres:" || protocol === "postgresql:";
      } catch {
        return false;
      }
    },
    { message: "Must be a valid PostgreSQL connection URL" },
  );

const originSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);

      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/" &&
        url.search === "" &&
        url.hash === ""
      );
    },
    { message: "Must contain only scheme, host, and optional port" },
  )
  .transform((value) => new URL(value).origin);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  DATABASE_URL: postgresUrlSchema,
  FRONTEND_ORIGIN: originSchema,
  JWT_ACCESS_SECRET: z
    .string()
    .refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
      message: "Must be at least 32 bytes",
    }),
  JWT_ISSUER: z.string().trim().min(1),
  JWT_AUDIENCE: z.string().trim().min(1),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce
    .number()
    .int()
    .positive()
    .max(60)
    .default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .max(365)
    .default(30),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const issues = formatZodIssues(result.error)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const env = Object.freeze(result.data);

export type Environment = z.infer<typeof environmentSchema>;
