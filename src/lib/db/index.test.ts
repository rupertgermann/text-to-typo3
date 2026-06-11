import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { resetDatabaseForTests, resolveDatabasePath } from "./index";
import { conversations, users } from "./schema";
import { db, setupTestDatabase, type TestDatabase } from "@/test/database";

describe("database factory", () => {
  let testDatabase: TestDatabase | null = null;

  afterEach(() => {
    testDatabase?.cleanup();
    testDatabase = null;
  });

  it("falls back to data/app.db when DATABASE_PATH is unset", () => {
    const previous = process.env.DATABASE_PATH;
    delete process.env.DATABASE_PATH;

    expect(resolveDatabasePath()).toBe(path.join(process.cwd(), "data", "app.db"));

    if (previous === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previous;
    }
  });

  it("uses DATABASE_PATH for a migrated test database", () => {
    testDatabase = setupTestDatabase();

    db.insert(users)
      .values({ typo3_uid: "42", display_name: "Test Editor" })
      .run();

    const user = db
      .select()
      .from(users)
      .where(eq(users.typo3_uid, "42"))
      .get();

    expect(fs.existsSync(testDatabase.databasePath)).toBe(true);
    expect(resolveDatabasePath()).toBe(testDatabase.databasePath);
    expect(user?.display_name).toBe("Test Editor");
  });

  it("applies pending migrations when opening an existing app database", () => {
    const previousDatabasePath = process.env.DATABASE_PATH;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "text-to-typo3-existing-db-"));
    const databasePath = path.join(tempDir, "app.sqlite");
    const oldMigrationsDir = path.join(tempDir, "drizzle-0002");

    try {
      createMigrationSubset(path.join(process.cwd(), "drizzle"), oldMigrationsDir, 2);

      const sqlite = new Database(databasePath);
      migrate(drizzle(sqlite), { migrationsFolder: oldMigrationsDir });
      sqlite.close();

      process.env.DATABASE_PATH = databasePath;
      resetDatabaseForTests();

      expect(() => db.select().from(conversations).all()).not.toThrow();

      const migratedSqlite = new Database(databasePath, { readonly: true });
      const columns = migratedSqlite.pragma("table_info(conversations)") as Array<{
        name: string;
      }>;
      migratedSqlite.close();

      expect(columns.map((column) => column.name)).toContain("auto_approve_writes");
    } finally {
      resetDatabaseForTests();

      if (previousDatabasePath === undefined) {
        delete process.env.DATABASE_PATH;
      } else {
        process.env.DATABASE_PATH = previousDatabasePath;
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function createMigrationSubset(sourceDir: string, targetDir: string, lastIndex: number): void {
  const targetMetaDir = path.join(targetDir, "meta");
  fs.mkdirSync(targetMetaDir, { recursive: true });

  const journalPath = path.join(sourceDir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= lastIndex);

  fs.writeFileSync(
    path.join(targetMetaDir, "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
  );

  for (const entry of journal.entries) {
    const fileName = `${entry.tag}.sql`;
    fs.copyFileSync(path.join(sourceDir, fileName), path.join(targetDir, fileName));
  }
}
