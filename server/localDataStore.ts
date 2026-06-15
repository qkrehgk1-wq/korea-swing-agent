import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentReport, Analysis, Stock, User, Watchlist } from "../drizzle/schema";

type LocalStore = {
  users: User[];
  stocks: Stock[];
  analyses: Analysis[];
  watchlist: Watchlist[];
  agentReports: AgentReport[];
};

const STORE_PATH = path.join(process.cwd(), ".data", "local-store.json");

const EMPTY_STORE: LocalStore = {
  users: [],
  stocks: [],
  analyses: [],
  watchlist: [],
  agentReports: [],
};

let cachedStore: LocalStore | null = null;

function reviveDates<T extends Record<string, unknown>>(record: T): T {
  const mutableRecord = record as Record<string, unknown>;
  const dateFields = [
    "createdAt",
    "updatedAt",
    "lastSignedIn",
    "analysisDate",
    "addedAt",
    "lastUpdated",
  ];

  for (const field of dateFields) {
    const value = mutableRecord[field];
    if (typeof value === "string") {
      mutableRecord[field] = new Date(value);
    }
  }

  return record;
}

async function ensureStoreDir() {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
}

export async function loadLocalStore(): Promise<LocalStore> {
  if (cachedStore) {
    return cachedStore;
  }

  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as LocalStore;
    cachedStore = {
      users: parsed.users.map(user => reviveDates(user)),
      stocks: parsed.stocks.map(stock => reviveDates(stock)),
      analyses: parsed.analyses.map(analysis => reviveDates(analysis)),
      watchlist: parsed.watchlist.map(item => reviveDates(item)),
      agentReports: parsed.agentReports.map(report => reviveDates(report)),
    };
    return cachedStore;
  } catch {
    cachedStore = structuredClone(EMPTY_STORE);
    return cachedStore;
  }
}

export async function saveLocalStore(store: LocalStore): Promise<void> {
  cachedStore = store;
  await ensureStoreDir();
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

export async function updateLocalStore(
  updater: (store: LocalStore) => void | LocalStore
): Promise<LocalStore> {
  const store = await loadLocalStore();
  const nextStore = updater(store) || store;
  await saveLocalStore(nextStore);
  return nextStore;
}

export function nextId(items: Array<{ id: number }>): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
}
