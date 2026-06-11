import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resolveDatabasePath } from "./index";
import { users } from "./schema";
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
});
