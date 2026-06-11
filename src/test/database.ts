import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDatabase } from "@/lib/db/migrate";
import { db, resetDatabaseForTests } from "@/lib/db";

export type TestDatabase = {
  databasePath: string;
  cleanup: () => void;
};

export function setupTestDatabase(): TestDatabase {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "text-to-typo3-test-"));
  const databasePath = path.join(tempDir, "app.sqlite");

  process.env.DATABASE_PATH = databasePath;
  resetDatabaseForTests();
  migrateDatabase();

  return {
    databasePath,
    cleanup() {
      resetDatabaseForTests();

      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

export { db };
