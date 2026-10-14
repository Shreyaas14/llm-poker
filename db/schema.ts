import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(),
  username: text("username").notNull(),
  usernameKey: text("username_key").notNull(),
  createdAt: integer("created_at").notNull(),
}, t => [uniqueIndex("profiles_username_unique").on(t.usernameKey)]);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  week: text("week").notNull(),
  mode: text("mode").notNull(),
  ranked: integer("ranked").notNull(),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  state: text("state").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  lockToken: text("lock_token"),
  lockUntil: integer("lock_until").notNull().default(0),
  finalPnl: integer("final_pnl"),
  providerCalls: integer("provider_calls").notNull().default(0),
}, t => [index("sessions_user_week").on(t.userId, t.week), index("sessions_leaderboard").on(t.week, t.mode, t.status)]);
