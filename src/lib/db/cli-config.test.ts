import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

it.each([
  { mode: "development", override: false, modeFiles: false, target: "configured.sqlite" },
  { mode: "development", override: true, modeFiles: false, target: "exported.sqlite" },
  { mode: "development", override: false, modeFiles: true, target: "development.sqlite" },
  { mode: "production", override: false, modeFiles: true, target: "production.sqlite" },
])("migrates $target for $mode with exported override=$override", ({ mode, override, modeFiles, target }) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "text-to-typo3-cli-"));
  const root = process.cwd();
  try {
    fs.copyFileSync(path.join(root, "drizzle.config.ts"), path.join(temporary, "drizzle.config.ts"));
    fs.cpSync(path.join(root, "drizzle"), path.join(temporary, "drizzle"), { recursive: true });
    fs.mkdirSync(path.join(temporary, "data"));
    fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
    if (modeFiles) {
      fs.writeFileSync(path.join(temporary, ".env.development.local"), "DATABASE_PATH=./development.sqlite\n");
      fs.writeFileSync(path.join(temporary, ".env.production.local"), "DATABASE_PATH=./production.sqlite\n");
    } else {
      fs.writeFileSync(path.join(temporary, ".env.local"), "DATABASE_PATH=./configured.sqlite\n");
    }
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: mode === "development" ? "development" : "production" };
    delete environment.DATABASE_PATH;
    if (override) environment.DATABASE_PATH = "./exported.sqlite";
    const require = createRequire(import.meta.url);

    execFileSync(process.execPath, [path.join(path.dirname(require.resolve("drizzle-kit")), "bin.cjs"), "migrate"], {
      cwd: temporary, env: environment, stdio: "pipe",
    });

    expect(fs.existsSync(path.join(temporary, target))).toBe(true);
    expect(fs.existsSync(path.join(temporary, "data/app.db"))).toBe(false);
    if (override) expect(fs.existsSync(path.join(temporary, "configured.sqlite"))).toBe(false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
