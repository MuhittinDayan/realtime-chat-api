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

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Must be an HTTP(S) URL without credentials, query, or fragment")
  .transform((value) => value.replace(/\/$/u, ""));

const bucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/u,
    "Must be a valid lowercase S3 bucket name",
  );

const booleanStringSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

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
  STORAGE_ENDPOINT: httpUrlSchema.optional(),
  STORAGE_REGION: z.string().trim().min(1).default("us-east-1"),
  STORAGE_ACCESS_KEY_ID: z.string().trim().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_FORCE_PATH_STYLE: booleanStringSchema.default(false),
  STORAGE_AVATAR_BUCKET: bucketNameSchema,
  STORAGE_ATTACHMENT_BUCKET: bucketNameSchema,
  STORAGE_PUBLIC_BASE_URL: httpUrlSchema,
  AVATAR_UPLOAD_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .max(3_600)
    .default(600),
  ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(60)
    .max(120)
    .default(60),
  CLAMAV_HOST: z.string().trim().min(1).default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).default(3_310),
  CLAMAV_SCAN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  CLAMAV_MAX_CONCURRENT_SCANS: z.coerce
    .number()
    .int()
    .positive()
    .default(4),
  CLAMAV_STREAM_MAX_LENGTH_BYTES: z.coerce
    .number()
    .int()
    .min(25 * 1_024 * 1_024 + 1)
    .default(32 * 1_024 * 1_024),
  MEDIA_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(900_000),
  MEDIA_STALE_UPLOAD_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(3_600_000),
  MEDIA_UNBOUND_ATTACHMENT_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(86_400_000),
  MEDIA_DELETED_ATTACHMENT_RETENTION_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000_000),
  AVATAR_CACHE_CONTROL: z
    .string()
    .trim()
    .min(1)
    .default("public, max-age=86400"),
})
  .refine(
    (value) => value.STORAGE_AVATAR_BUCKET !== value.STORAGE_ATTACHMENT_BUCKET,
    {
      path: ["STORAGE_ATTACHMENT_BUCKET"],
      message: "Must be different from STORAGE_AVATAR_BUCKET",
    },
  );

const result = environmentSchema.safeParse(process.env);

if (!result.success) {
  const issues = formatZodIssues(result.error)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${issues}`);
}

export const env = Object.freeze(result.data);

export type Environment = z.infer<typeof environmentSchema>;
