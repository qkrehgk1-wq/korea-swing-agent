import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  users,
  stocks,
  analyses,
  InsertAnalysis,
  watchlist,
  agentReports,
  InsertAgentReport,
  type User,
  type Stock,
  type Analysis,
  type Watchlist,
  type AgentReport,
} from "../drizzle/schema";
import { ENV } from "./_core/env";
import { loadLocalStore, nextId, saveLocalStore } from "./localDataStore";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

function shouldUseLocalFallback() {
  return ENV.allowLocalStoreFallback;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    const existingIndex = store.users.findIndex(existing => existing.openId === user.openId);
    const now = new Date();
    const baseUser: User =
      existingIndex >= 0
        ? store.users[existingIndex]
        : {
            id: nextId(store.users),
            openId: user.openId,
            name: null,
            email: null,
            loginMethod: null,
            role: user.openId === ENV.ownerOpenId ? "admin" : "user",
            createdAt: now,
            updatedAt: now,
            lastSignedIn: now,
          };

    const mergedUser: User = {
      ...baseUser,
      name: user.name ?? baseUser.name,
      email: user.email ?? baseUser.email,
      loginMethod: user.loginMethod ?? baseUser.loginMethod,
      role: user.role ?? baseUser.role,
      lastSignedIn: user.lastSignedIn ?? now,
      updatedAt: now,
    };

    if (existingIndex >= 0) {
      store.users[existingIndex] = mergedUser;
    } else {
      store.users.push(mergedUser);
    }

    await saveLocalStore(store);
    return;
  }
  if (!db) throw new Error("Database not available");

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    return store.users.find(user => user.openId === openId);
  }
  if (!db) throw new Error("Database not available");

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Stock analysis queries
export async function getOrCreateStock(ticker: string, profile?: Record<string, unknown>) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    const existing = store.stocks.find(stock => stock.ticker === ticker);
    if (existing) {
      return existing;
    }

    const now = new Date();
    const stock: Stock = {
      id: nextId(store.stocks),
      ticker,
      companyName: (profile?.name as string | undefined) ?? null,
      industry: (profile?.industry as string | undefined) ?? null,
      website: (profile?.website as string | undefined) ?? null,
      description: (profile?.description as string | undefined) ?? null,
      lastUpdated: now,
      createdAt: now,
    };
    store.stocks.push(stock);
    await saveLocalStore(store);
    return stock;
  }
  if (!db) throw new Error("Database not available");

  const existing = await db.select().from(stocks).where(eq(stocks.ticker, ticker)).limit(1);
  
  if (existing.length > 0) {
    return existing[0];
  }

  const result = await db.insert(stocks).values({
    ticker,
    companyName: profile?.name as string | undefined,
    industry: profile?.industry as string | undefined,
    website: profile?.website as string | undefined,
    description: profile?.description as string | undefined,
  });

  return db.select().from(stocks).where(eq(stocks.ticker, ticker)).limit(1).then(r => r[0]);
}

export async function createAnalysis(analysisData: InsertAnalysis) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    const now = new Date();
    const analysis: Analysis = {
      id: nextId(store.analyses),
      userId: analysisData.userId,
      stockId: analysisData.stockId,
      ticker: analysisData.ticker,
      fundamentalAnalysis: analysisData.fundamentalAnalysis ?? null,
      technicalAnalysis: analysisData.technicalAnalysis ?? null,
      insiderAnalysis: analysisData.insiderAnalysis ?? null,
      riskAnalysis: analysisData.riskAnalysis ?? null,
      billionaireFramework: analysisData.billionaireFramework ?? null,
      investmentInsight: analysisData.investmentInsight ?? null,
      asymmetricGrowthScore: analysisData.asymmetricGrowthScore ?? null,
      analysisDate: now,
      createdAt: now,
    };
    store.analyses.push(analysis);
    await saveLocalStore(store);
    return analysis;
  }
  if (!db) throw new Error("Database not available");

  const result = await db.insert(analyses).values(analysisData);
  const analysisId = (result as any)[0]?.insertId;
  
  return db.select().from(analyses).where(eq(analyses.id, analysisId as number)).limit(1).then(r => r[0]);
}

export async function getAnalysisByIdWithReports(analysisId: number) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    return {
      analysis: store.analyses.find(item => item.id === analysisId),
      reports: store.agentReports.filter(report => report.analysisId === analysisId),
    };
  }
  if (!db) throw new Error("Database not available");

  const analysis = await db.select().from(analyses).where(eq(analyses.id, analysisId)).limit(1);
  const reports = await db.select().from(agentReports).where(eq(agentReports.analysisId, analysisId));
  
  return { analysis: analysis[0], reports };
}

export async function getUserAnalysisHistory(userId: number, limit = 20) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    return store.analyses
      .filter(analysis => analysis.userId === userId)
      .sort((a, b) => b.analysisDate.getTime() - a.analysisDate.getTime())
      .slice(0, limit);
  }
  if (!db) throw new Error("Database not available");

  return db.select().from(analyses).where(eq(analyses.userId, userId)).limit(limit);
}

export async function addToWatchlist(userId: number, ticker: string) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    const exists = store.watchlist.some(item => item.userId === userId && item.ticker === ticker);
    if (!exists) {
      const watchItem: Watchlist = {
        id: nextId(store.watchlist),
        userId,
        ticker,
        addedAt: new Date(),
      };
      store.watchlist.push(watchItem);
      await saveLocalStore(store);
    }
    return;
  }
  if (!db) throw new Error("Database not available");

  await db.insert(watchlist).values({ userId, ticker });
}

export async function getUserWatchlist(userId: number) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    return store.watchlist.filter(item => item.userId === userId);
  }
  if (!db) throw new Error("Database not available");

  return db.select().from(watchlist).where(eq(watchlist.userId, userId));
}

export async function removeFromWatchlist(userId: number, ticker: string) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    store.watchlist = store.watchlist.filter(
      item => !(item.userId === userId && item.ticker === ticker)
    );
    await saveLocalStore(store);
    return;
  }
  if (!db) throw new Error("Database not available");

  const watchlistTable = watchlist;
  await db.delete(watchlistTable).where(
    and(eq(watchlistTable.userId, userId), eq(watchlistTable.ticker, ticker))
  );
}

export async function createAgentReport(reportData: InsertAgentReport) {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    const report: AgentReport = {
      id: nextId(store.agentReports),
      analysisId: reportData.analysisId,
      agentRole: reportData.agentRole,
      report: reportData.report,
      confidence: reportData.confidence ?? null,
      createdAt: new Date(),
    };
    store.agentReports.push(report);
    await saveLocalStore(store);
    return;
  }
  if (!db) throw new Error("Database not available");

  await db.insert(agentReports).values(reportData);
}

export async function getAllWatchlist() {
  const db = await getDb();
  if (!db && shouldUseLocalFallback()) {
    const store = await loadLocalStore();
    return store.watchlist;
  }
  if (!db) throw new Error("Database not available");
  return db.select().from(watchlist);
}
