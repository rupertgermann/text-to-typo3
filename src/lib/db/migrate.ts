import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { db } from "./index";
import path from "node:path";

migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });

console.log("Migrations applied successfully.");
