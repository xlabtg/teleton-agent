import { fetchWithTimeout } from "../../../utils/fetch.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("Tools");

const ASSET_LIST_URL = "https://assets.dedust.io/list.json";
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface DedustAsset {
  type: "native" | "jetton";
  address?: string;
  name: string;
  symbol: string;
  image?: string;
  decimals: number;
  sell_tax?: number;
  buy_tax?: number;
}

let cachedAssets: DedustAsset[] = [];
let cacheTimestamp = 0;

/**
 * Fetch and cache the asset list. Uses stale-while-revalidate on fetch failure.
 */
export async function getAssetList(): Promise<DedustAsset[]> {
  if (cachedAssets.length > 0 && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedAssets;
  }

  try {
    const response = await fetchWithTimeout(ASSET_LIST_URL, { cacheTtlMs: CACHE_TTL_MS });
    if (!response.ok) {
      throw new Error(`Failed to fetch asset list: ${response.status}`);
    }

    cachedAssets = await response.json();
    cacheTimestamp = Date.now();
    return cachedAssets;
  } catch (error) {
    // Stale-while-revalidate: return old cache if available
    if (cachedAssets.length > 0) {
      log.warn({ err: error }, "Asset list fetch failed, using stale cache");
      return cachedAssets;
    }
    throw error;
  }
}

export async function findAsset(addressOrTon: string): Promise<DedustAsset | undefined> {
  const assets = await getAssetList();

  if (addressOrTon.toLowerCase() === "ton") {
    return assets.find((a) => a.type === "native");
  }

  const normalized = addressOrTon.toLowerCase();
  return assets.find((a) => a.type === "jetton" && a.address?.toLowerCase() === normalized);
}

export async function findAssetBySymbol(symbol: string): Promise<DedustAsset | undefined> {
  const assets = await getAssetList();
  const upper = symbol.toUpperCase();
  return assets.find((a) => a.symbol.toUpperCase() === upper);
}

export async function getDecimals(addressOrTon: string): Promise<number> {
  const asset = await findAsset(addressOrTon);
  return asset?.decimals ?? 9;
}

export { toUnits, fromUnits } from "../../../ton/units.js";
