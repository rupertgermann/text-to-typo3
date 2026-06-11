import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

export function resolveDatabasePath(): string {
  const configuredPath = process.env.DATABASE_PATH?.trim();

  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.join(process.cwd(), "data", "app.db");
}

function getDb(): BetterSQLite3Database<typeof schema> {
  if (!_db) {
    const databasePath = resolveDatabasePath();
    const dbDir = path.dirname(databasePath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    const sqlite = new Database(databasePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    const database = drizzle(sqlite, { schema });
    try {
      migrate(database, { migrationsFolder: path.join(process.cwd(), "drizzle") });
      ensureCurrentSchema(sqlite);
    } catch (error) {
      sqlite.close();
      throw error;
    }

    _sqlite = sqlite;
    _db = database;
  }
  return _db;
}

function ensureCurrentSchema(sqlite: Database.Database): void {
  const userSettingsColumns = sqlite.pragma("table_info(user_settings)") as Array<{
    name: string;
  }>;

  if (
    userSettingsColumns.length > 0 &&
    !userSettingsColumns.some((column) => column.name === "model_context_window")
  ) {
    sqlite.exec("ALTER TABLE user_settings ADD COLUMN model_context_window integer");
  }
}

export function resetDatabaseForTests(): void {
  _sqlite?.close();
  _sqlite = null;
  _db = null;
}

// Lazy proxy to avoid opening SQLite at module evaluation time (Next.js parallel builds)
export const db: BetterSQLite3Database<typeof schema> = new Proxy(
  {} as BetterSQLite3Database<typeof schema>,
  {
    get(_target, prop, receiver) {
      const real = getDb();
      const value = Reflect.get(real, prop, receiver);
      if (typeof value === "function") {
        return value.bind(real);
      }
      return value;
    },
  },
);
