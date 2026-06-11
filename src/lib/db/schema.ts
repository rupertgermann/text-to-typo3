import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql, type InferSelectModel } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, ""))
    .notNull(),
  typo3_uid: text("typo3_uid").unique().notNull(),
  display_name: text("display_name").notNull(),
  created_at: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
});

export const sessions = sqliteTable("sessions", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, ""))
    .notNull(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  access_token: text("access_token").notNull(),
  refresh_token: text("refresh_token"),
  expires_at: integer("expires_at"),
  created_at: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [index("sessions_user_id_idx").on(table.user_id)]);

export const conversations = sqliteTable("conversations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, ""))
    .notNull(),
  user_id: text("user_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  auto_approve_writes: integer("auto_approve_writes"),
  created_at: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
  updated_at: integer("updated_at")
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [index("conversations_user_id_idx").on(table.user_id)]);

export const messages = sqliteTable("messages", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID().replace(/-/g, ""))
    .notNull(),
  conversation_id: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  tool_calls: text("tool_calls"),
  input_tokens: integer("input_tokens"),
  output_tokens: integer("output_tokens"),
  created_at: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`),
}, (table) => [index("messages_conversation_id_idx").on(table.conversation_id)]);

export const userSettings = sqliteTable("user_settings", {
  user_id: text("user_id")
    .primaryKey()
    .references(() => users.id),
  model_id: text("model_id"),
  openai_api_key: text("openai_api_key"),
  lmstudio_base_url: text("lmstudio_base_url"),
  lmstudio_model_id: text("lmstudio_model_id"),
  custom_providers: text("custom_providers"),
});

export type User = InferSelectModel<typeof users>;
export type Session = InferSelectModel<typeof sessions>;
export type Conversation = InferSelectModel<typeof conversations>;
export type Message = InferSelectModel<typeof messages>;
export type UserSettings = InferSelectModel<typeof userSettings>;
