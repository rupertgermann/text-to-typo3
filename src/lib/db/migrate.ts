import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function migrateDatabase(database = db): void {
  migrate(database, { migrationsFolder: path.join(process.cwd(), "drizzle") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateDatabase();
  console.log("Migrations applied successfully.");
}
