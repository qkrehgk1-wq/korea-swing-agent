import { describe, it, expect, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(userId = 1): { ctx: TrpcContext } {
  const user: AuthenticatedUser = {
    id: userId,
    openId: `test-user-${userId}`,
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  const ctx: TrpcContext = {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };

  return { ctx };
}

describe("stocks.analyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should analyze a Korean ticker and return a deterministic-safe result", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    // In NODE_ENV=test the MCP layer returns null, so the engine falls back to
    // the deterministic analysis — fast and network-free.
    const result = await caller.stocks.analyze({ ticker: "005930" });

    expect(result.success).toBe(true);
    expect(result.ticker).toBe("005930");
    expect(result.framework).toBeDefined();
    expect(result.framework.asymmetricGrowthScore).toBeGreaterThanOrEqual(0);
    expect(result.framework.asymmetricGrowthScore).toBeLessThanOrEqual(100);
    expect(typeof result.investmentInsight).toBe("string");
    expect(result.investmentInsight.length).toBeGreaterThan(0);
  });

  it("should reject non-Korean tickers with a BAD_REQUEST", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.stocks.analyze({ ticker: "AAPL" })).rejects.toThrow();
  });

  it("should retrieve analysis history for the authenticated user", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const history = await caller.stocks.getHistory();
    expect(Array.isArray(history)).toBe(true);
  });
});

describe("watchlist operations", () => {
  it("should add a Korean ticker to the watchlist", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.watchlist.add({ ticker: "035720" });
    expect(result.success).toBe(true);
  });

  it("should reject a non-Korean ticker", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.watchlist.add({ ticker: "MSFT" })).rejects.toThrow();
  });

  it("should list and remove watchlist entries", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const watchlist = await caller.watchlist.list();
    expect(Array.isArray(watchlist)).toBe(true);

    const removed = await caller.watchlist.remove({ ticker: "035720" });
    expect(removed.success).toBe(true);
  });
});
