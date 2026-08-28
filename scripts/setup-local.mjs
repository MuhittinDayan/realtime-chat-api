import "dotenv/config";

import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath;
const storageOnly = process.argv.includes("--storage-only");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    ...options,
  });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with status ${String(result.status)}`,
    );
  }
}

function runNpmScript(script, environment = process.env) {
  if (npmExecPath !== undefined && npmExecPath.length > 0) {
    run(process.execPath, [npmExecPath, "run", script], {
      env: environment,
    });
    return;
  }

  run(npmCommand, ["run", script], {
    env: environment,
    shell: process.platform === "win32",
  });
}

function setupStorage() {
  const avatarBucket = process.env.STORAGE_AVATAR_BUCKET ?? "chat-avatars";
  const attachmentBucket =
    process.env.STORAGE_ATTACHMENT_BUCKET ?? "chat-attachments";

  if (avatarBucket === attachmentBucket) {
    throw new Error("Avatar and attachment storage must use separate buckets.");
  }

  const publicPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadProcessedPublicAvatars",
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${avatarBucket}/public/*`],
      },
    ],
  });

  run("docker", [
    "compose",
    "exec",
    "-T",
    "minio",
    "sh",
    "-c",
    'mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && ' +
      'mc mb --ignore-existing "local/$1" "local/$2" && ' +
      'policy_file=$(mktemp /tmp/chat-storage-policy.XXXXXX) && ' +
      'printf "%s" "$3" >"$policy_file" && ' +
      'mc anonymous set-json "$policy_file" "local/$1" && ' +
      'mc anonymous set private "local/$2" && ' +
      'rm -f "$policy_file"',
    "storage-setup",
    avatarBucket,
    attachmentBucket,
    publicPolicy,
  ]);
}

run("docker", [
  "compose",
  "up",
  "-d",
  "--wait",
  ...(storageOnly ? ["minio"] : ["postgres", "minio"]),
]);
setupStorage();

if (storageOnly) {
  console.info("Local object storage buckets, CORS, and policies are ready.");
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error(
    "DATABASE_URL is required. Copy .env.example to .env before setup.",
  );
}

const testDatabaseUrl = new URL(databaseUrl);
testDatabaseUrl.pathname = "/chat_test";
testDatabaseUrl.search = "";
testDatabaseUrl.hash = "";

runNpmScript("prisma:generate");

run(
  "docker",
  [
    "compose",
    "exec",
    "-T",
    "postgres",
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres",
  ],
  {
    stdio: ["pipe", "inherit", "inherit"],
    input:
      "SELECT 'CREATE DATABASE chat_test' " +
      "WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'chat_test')\\gexec\n",
  },
);

runNpmScript("prisma:migrate:deploy");
runNpmScript("prisma:migrate:deploy", {
  ...process.env,
  DATABASE_URL: testDatabaseUrl.toString(),
});
runNpmScript("prisma:seed");

console.info(
  "Local PostgreSQL, object storage, migrations, test database, and seed are ready.",
);
