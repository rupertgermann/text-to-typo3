import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scaffoldScript = fileURLToPath(new URL("../../scripts/scaffold.mjs", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scaffoldFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "scaffold-test-"));
  temporaryDirectories.push(directory);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  for (const command of ["ddev", "composer", "php"]) {
    writeFileSync(path.join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [scaffoldScript, ...args], {
      cwd: directory,
      env: { NODE_ENV: "test", PATH: bin, TYPO3_OAUTH_CLIENT_ID: "new-client", TYPO3_OAUTH_CLIENT_SECRET: "new-secret" },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  };
  return { directory, run, envPath: path.join(directory, ".env.local") };
}

describe("scaffold environment file", () => {
  it("does not create files or directories during a dry run", () => {
    const { directory, envPath, run } = scaffoldFixture();
    run("--dry-run");
    expect(existsSync(path.join(directory, "typo3-instance"))).toBe(false);
    expect(existsSync(envPath)).toBe(false);
  });

  it.each([false, true])("preserves application secrets and comments with force=%s", (force) => {
    const { envPath, run } = scaffoldFixture();
    if (force) run();
    const applicationSettings = "# Keep application credentials\nENCRYPTION_KEY=existing-encryption\nSESSION_SECRET=existing-session\nOPENAI_API_KEY=existing-api # provider key\n\n";
    writeFileSync(envPath, `${applicationSettings}TYPO3_BASE_URL=https://old.example\nexport TYPO3_OAUTH_CLIENT_ID =old-client\nTYPO3_OAUTH_CLIENT_ID=old-client`);

    run(...(force ? ["--force"] : []));

    const updated = readFileSync(envPath, "utf8");
    expect(updated).toContain(applicationSettings);
    expect(updated).toContain("TYPO3_BASE_URL=https://typo3-instance.ddev.site");
    expect(updated).toContain("TYPO3_OAUTH_CLIENT_ID=new-client");
    expect(updated).toContain("export TYPO3_OAUTH_CLIENT_ID=new-client");
    expect(updated).toContain("TYPO3_OAUTH_CLIENT_SECRET=new-secret");
    expect(updated.match(/^TYPO3_BASE_URL=/gm)).toHaveLength(1);
    expect(updated).not.toContain("old-client");
    run();
    expect(readFileSync(envPath, "utf8")).toBe(updated);
  });

  it("restores a missing environment file from saved scaffold state", () => {
    const { envPath, run } = scaffoldFixture();
    run();
    const original = readFileSync(envPath, "utf8");
    rmSync(envPath);
    run();
    expect(readFileSync(envPath, "utf8")).toBe(original);
  });
});
