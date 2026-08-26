import "dotenv/config";

import { spawnSync } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmExecPath = process.env.npm_execpath;
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

run("docker", ["compose", "up", "-d", "--wait", "postgres"]);
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

console.info("Local PostgreSQL, migrations, test database, and seed are ready.");
