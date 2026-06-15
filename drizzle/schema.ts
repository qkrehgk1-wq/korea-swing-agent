import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// Stock analysis tables
export const stocks = mysqlTable("stocks", {
  id: int("id").autoincrement().primaryKey(),
  ticker: varchar("ticker", { length: 10 }).notNull().unique(),
  companyName: text("company_name"),
  industry: varchar("industry", { length: 255 }),
  website: varchar("website", { length: 255 }),
  description: text("description"),
  lastUpdated: timestamp("last_updated").defaultNow().onUpdateNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Stock = typeof stocks.$inferSelect;
export type InsertStock = typeof stocks.$inferInsert;

export const analyses = mysqlTable("analyses", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  stockId: int("stock_id").notNull(),
  ticker: varchar("ticker", { length: 10 }).notNull(),
  fundamentalAnalysis: text("fundamental_analysis"),
  technicalAnalysis: text("technical_analysis"),
  insiderAnalysis: text("insider_analysis"),
  riskAnalysis: text("risk_analysis"),
  billionaireFramework: text("billionaire_framework"),
  investmentInsight: text("investment_insight"),
  asymmetricGrowthScore: int("asymmetric_growth_score"),
  analysisDate: timestamp("analysis_date").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type Analysis = typeof analyses.$inferSelect;
export type InsertAnalysis = typeof analyses.$inferInsert;

export const watchlist = mysqlTable("watchlist", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  ticker: varchar("ticker", { length: 10 }).notNull(),
  addedAt: timestamp("added_at").defaultNow().notNull(),
});

export type Watchlist = typeof watchlist.$inferSelect;
export type InsertWatchlist = typeof watchlist.$inferInsert;

export const agentReports = mysqlTable("agent_reports", {
  id: int("id").autoincrement().primaryKey(),
  analysisId: int("analysis_id").notNull(),
  agentRole: varchar("agent_role", { length: 100 }).notNull(),
  report: text("report").notNull(),
  confidence: int("confidence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AgentReport = typeof agentReports.$inferSelect;
export type InsertAgentReport = typeof agentReports.$inferInsert;