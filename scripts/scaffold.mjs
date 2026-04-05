#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_INSTANCE_DIR = "typo3-instance";
const DEFAULT_TEST_EDITOR_USERNAME = "editor";
const DEFAULT_TEST_EDITOR_EMAIL = "editor@example.com";
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_EMAIL = "admin@example.com";
const DEFAULT_PHP_VERSION = "8.3";

function parseArgs(argv) {
  const options = {
    dryRun: false,
    force: false,
    instanceDir: DEFAULT_INSTANCE_DIR,
    phpVersion: DEFAULT_PHP_VERSION,
    projectName: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--instance-dir" || arg === "-i") {
      const value = argv[++i];
      if (!value) throw new Error("--instance-dir requires a value");
      options.instanceDir = value;
      continue;
    }
    if (arg === "--php-version") {
      const value = argv[++i];
      if (!value) throw new Error("--php-version requires a value");
      options.phpVersion = value;
      continue;
    }
    if (arg === "--project-name") {
      const value = argv[++i];
      if (!value) throw new Error("--project-name requires a value");
      options.projectName = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandString(command, args = []) {
  return [command, ...args].map(shellQuote).join(" ");
}

function humanList(values) {
  if (values.length === 0) return "";
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

async function run(command, args, { cwd, env } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was terminated by ${signal}`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function canRun(command) {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      stdio: "ignore",
      shell: false,
    });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

function generateSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString("base64url")}`;
}

function resolveProjectName(instanceDir, overrideName) {
  if (overrideName) return overrideName;
  const base = path.basename(path.resolve(instanceDir));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "typo3-instance";
}

function buildPlan(config) {
  const backendUrl = `https://${config.projectName}.ddev.site/typo3/`;
  const credentials = {
    adminUsername: process.env.TYPO3_SETUP_ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME,
    adminPassword: process.env.TYPO3_SETUP_ADMIN_PASSWORD || generateSecret("Admin"),
    adminEmail: process.env.TYPO3_SETUP_ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL,
    editorUsername: process.env.TYPO3_TEST_EDITOR_USERNAME || DEFAULT_TEST_EDITOR_USERNAME,
    editorPassword:
      process.env.TYPO3_TEST_EDITOR_PASSWORD || generateSecret("Editor"),
    editorEmail: process.env.TYPO3_TEST_EDITOR_EMAIL || DEFAULT_TEST_EDITOR_EMAIL,
  };

  const oauthClientId =
    process.env.TYPO3_OAUTH_CLIENT_ID || generateSecret("client");
  const oauthClientSecret =
    process.env.TYPO3_OAUTH_CLIENT_SECRET || generateSecret("secret");

  const envFile = [
    `TYPO3_BASE_URL=https://${config.projectName}.ddev.site`,
    `TYPO3_OAUTH_CLIENT_ID=${oauthClientId}`,
    `TYPO3_OAUTH_CLIENT_SECRET=${oauthClientSecret}`,
    `TYPO3_TEST_EDITOR_USERNAME=${credentials.editorUsername}`,
    `TYPO3_TEST_EDITOR_PASSWORD=${credentials.editorPassword}`,
    `TYPO3_TEST_EDITOR_EMAIL=${credentials.editorEmail}`,
  ].join("\n");

  return {
    backendUrl,
    credentials,
    oauthClientId,
    oauthClientSecret,
    envFile,
    steps: [
      {
        name: "Configure DDEV project",
        command: "ddev",
        args: [
          "config",
          "--auto",
          "--project-type=typo3",
          "--docroot=public",
          `--php-version=${config.phpVersion}`,
          `--project-name=${config.projectName}`,
        ],
      },
      { name: "Start DDEV", command: "ddev", args: ["start"] },
      {
        name: "Install TYPO3 base distribution",
        command: "ddev",
        args: [
          "composer",
          "create-project",
          "typo3/cms-base-distribution:^13",
          "--no-interaction",
          "--prefer-dist",
        ],
      },
      {
        name: "Install TYPO3 MCP server",
        command: "ddev",
        args: ["composer", "require", "hn/typo3-mcp-server", "--no-interaction"],
      },
      {
        name: "Run TYPO3 setup",
        command: "ddev",
        args: ["typo3", "setup", "--force", "--no-interaction"],
        env: {
          TYPO3_DB_DRIVER: "mysqli",
          TYPO3_DB_HOST: "db",
          TYPO3_DB_PORT: "3306",
          TYPO3_DB_DBNAME: "db",
          TYPO3_DB_USERNAME: "db",
          TYPO3_DB_PASSWORD: "db",
          TYPO3_SETUP_ADMIN_USERNAME: credentials.adminUsername,
          TYPO3_SETUP_ADMIN_PASSWORD: credentials.adminPassword,
          TYPO3_SETUP_ADMIN_EMAIL: credentials.adminEmail,
          TYPO3_SETUP_CREATE_SITE: `https://${config.projectName}.ddev.site/`,
          TYPO3_PROJECT_NAME: config.projectName,
          TYPO3_SERVER_TYPE: "other",
        },
      },
      {
        name: "Create backend user groups",
        command: "ddev",
        args: ["typo3", "setup:begroups:default", "-g", "Both", "--no-interaction"],
      },
      {
        name: "Create test editor backend user",
        command: "ddev",
        args: ["typo3", "backend:user:create", "--no-interaction"],
        env: {
          TYPO3_BE_USER_NAME: credentials.editorUsername,
          TYPO3_BE_USER_EMAIL: credentials.editorEmail,
          TYPO3_BE_USER_PASSWORD: credentials.editorPassword,
          TYPO3_BE_USER_ADMIN: "0",
          TYPO3_BE_USER_MAINTAINER: "0",
          TYPO3_BE_USER_GROUPS:
            process.env.TYPO3_SCAFFOLD_EDITOR_GROUP_IDS || "",
        },
      },
      {
        name: "Activate helper extensions",
        command: "ddev",
        args: ["typo3", "extension:setup"],
      },
      {
        name: "Enable indexed_search",
        command: "ddev",
        args: ["typo3", "extension:activate", "indexed_search"],
      },
      {
        name: "Enable styleguide",
        command: "ddev",
        args: ["typo3", "extension:activate", "styleguide"],
      },
      {
        name: "Seed demo TCA content",
        command: "ddev",
        args: ["typo3", "styleguide:generate", "-c"],
      },
      {
        name: "Register OAuth client",
        note:
          "No project-specific registration command is wired yet. Use the generated credentials in .env.local to create the TYPO3 OAuth client, or provide TYPO3_SCAFFOLD_OAUTH_CLIENT_COMMAND to automate this step.",
      },
      {
        name: "Write .env.local",
        writeFile: ".env.local",
        content: envFile,
      },
      {
        name: "Persist scaffold state",
        writeFile: path.join(config.instanceDir, ".codex-scaffold", "state.json"),
        content: JSON.stringify(
          {
            version: 1,
            projectName: config.projectName,
            instanceDir: config.instanceDir,
            backendUrl,
            oauthClientId,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function printHelp() {
  console.log(`Usage: pnpm scaffold [--dry-run] [--force] [--instance-dir <dir>] [--php-version <version>] [--project-name <name>]`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));

  if (config.help) {
    await printHelp();
    return;
  }

  const repoRoot = process.cwd();
  const instanceDir = path.resolve(repoRoot, config.instanceDir);
  config.instanceDir = instanceDir;
  config.projectName = resolveProjectName(instanceDir, config.projectName);

  const statePath = path.join(instanceDir, ".codex-scaffold", "state.json");
  const envPath = path.join(repoRoot, ".env.local");

  if (!config.dryRun && (await fileExists(statePath)) && !config.force) {
    const existing = JSON.parse(await readFile(statePath, "utf8"));
    console.log(`Scaffold already set up for ${existing.projectName}.`);
    console.log(`TYPO3 backend URL: ${existing.backendUrl}`);
    console.log(`Chat app start command: pnpm dev`);
    return;
  }

  const missingPrereqs = [];
  if (!config.dryRun) {
    for (const command of ["ddev", "composer", "php"]) {
      if (!(await canRun(command))) {
        missingPrereqs.push(command);
      }
    }
  }

  if (missingPrereqs.length > 0) {
    console.error(`Missing prerequisite(s): ${humanList(missingPrereqs)}.`);
    console.error("Install them or rerun with --dry-run to preview the scaffold plan.");
    process.exitCode = 1;
    return;
  }

  const plan = buildPlan(config);
  await ensureDir(instanceDir);
  await ensureDir(path.join(instanceDir, ".codex-scaffold"));

  console.log(`Scaffolding TYPO3 instance in ${instanceDir}`);
  console.log(`Project name: ${config.projectName}`);
  console.log(`Mode: ${config.dryRun ? "dry-run" : "execute"}`);
  console.log("");

  for (const step of plan.steps) {
    if (step.note) {
      console.log(`- ${step.name}: ${step.note}`);
      continue;
    }

    console.log(`- ${step.name}`);

    if (step.writeFile) {
      const targetPath = path.resolve(repoRoot, step.writeFile);
      console.log(`  write ${targetPath}`);
      if (config.dryRun) {
        continue;
      }
      await ensureDir(path.dirname(targetPath));
      await writeFile(targetPath, step.content, "utf8");
      continue;
    }

    const commandLine = commandString(step.command, step.args);
    console.log(`  ${commandLine}`);

    if (config.dryRun) {
      continue;
    }

    await run(step.command, step.args, {
      cwd: instanceDir,
      env: step.env,
    });
  }

  if (config.dryRun) {
    console.log("");
    console.log("Dry run complete. Nothing was written.");
    console.log(`Planned .env.local path: ${envPath}`);
    console.log(`Planned TYPO3 backend URL: ${plan.backendUrl}`);
    return;
  }

  if (!(await fileExists(envPath))) {
    await writeFile(envPath, plan.envFile, "utf8");
  }

  console.log("");
  console.log("Scaffold complete.");
  console.log(`TYPO3 backend URL: ${plan.backendUrl}`);
  console.log(`Chat app start command: pnpm dev`);
  console.log(`Test editor credentials: ${plan.credentials.editorUsername} / ${plan.credentials.editorPassword}`);
  console.log(`Admin credentials: ${plan.credentials.adminUsername} / ${plan.credentials.adminPassword}`);
  console.log(`OAuth client: ${plan.oauthClientId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
