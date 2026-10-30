import { resolve } from "node:path";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function absoluteHttpsUrl(value: string | undefined, fallback: string, name: string): string {
  const raw = value ?? fallback;
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return raw;
}

function httpsUrlList(value: string | undefined): string[] {
  return (value ?? "https://cdn.jsdelivr.net/gh,https://testingcf.jsdelivr.net/gh").split(",")
    .map((url) => url.trim()).filter(Boolean)
    .map((url) => absoluteHttpsUrl(url, url, "WF_GITHUB_CDN_BASE_URLS").replace(/\/+$/u, ""));
}

export const config = {
  dataDirectory: resolve(process.env.DATASOURCE_DATA_DIR ?? "data"),
  tmpDirectory: resolve(process.env.DATASOURCE_TMP_DIR ?? "tmp"),
  githubCdnBaseUrls: httpsUrlList(process.env.WF_GITHUB_CDN_BASE_URLS),
  plusRawBaseUrl: absoluteHttpsUrl(
    process.env.WF_PLUS_RAW_BASE_URL,
    "https://raw.githubusercontent.com/calamity-inc/warframe-public-export-plus/senpai",
    "WF_PLUS_RAW_BASE_URL",
  ),
  warframeGameDir: process.env.WF_GAME_DIR ? resolve(process.env.WF_GAME_DIR) : undefined,
  plutoDirectory: resolve(process.env.WF_PLUTO_DIR ?? "pluto"),
  plutoRuntime: process.env.WF_PLUTO_RUNTIME,
  packagesBinDir: process.env.WF_PACKAGES_BIN_DIR ? resolve(process.env.WF_PACKAGES_BIN_DIR) : undefined,
  plutoTimeoutMs: positiveInteger(process.env.WF_PLUTO_TIMEOUT_MS, 30 * 60 * 1000, "WF_PLUTO_TIMEOUT_MS"),
  requestTimeoutMs: positiveInteger(process.env.DATASOURCE_REQUEST_TIMEOUT_MS, 30_000, "DATASOURCE_REQUEST_TIMEOUT_MS"),
  maxResponseBytes: positiveInteger(process.env.DATASOURCE_MAX_RESPONSE_BYTES, 64 * 1024 * 1024, "DATASOURCE_MAX_RESPONSE_BYTES"),
  requestRetries: positiveInteger(process.env.DATASOURCE_REQUEST_RETRIES, 5, "DATASOURCE_REQUEST_RETRIES"),
  publicExportIndexUrl: absoluteHttpsUrl(
    process.env.WF_PUBLIC_EXPORT_INDEX_URL,
    "https://content.warframe.com/PublicExport/index_{language}.txt.lzma",
    "WF_PUBLIC_EXPORT_INDEX_URL",
  ),
  publicExportIndexFallbackUrl: absoluteHttpsUrl(
    process.env.WF_PUBLIC_EXPORT_INDEX_FALLBACK_URL,
    "https://origin.warframe.com/PublicExport/index_{language}.txt.lzma",
    "WF_PUBLIC_EXPORT_INDEX_FALLBACK_URL",
  ),
  publicExportManifestUrl: absoluteHttpsUrl(
    process.env.WF_PUBLIC_EXPORT_MANIFEST_URL,
    "https://content.warframe.com/PublicExport/Manifest/{file}",
    "WF_PUBLIC_EXPORT_MANIFEST_URL",
  ),
  marketRivenAttributesUrl: absoluteHttpsUrl(
    process.env.WF_MARKET_RIVEN_ATTRIBUTES_URL,
    "https://api.warframe.market/v2/riven/attributes",
    "WF_MARKET_RIVEN_ATTRIBUTES_URL",
  ),
  marketRivenWeaponsUrl: absoluteHttpsUrl(
    process.env.WF_MARKET_RIVEN_WEAPONS_URL,
    "https://api.warframe.market/v2/riven/weapons",
    "WF_MARKET_RIVEN_WEAPONS_URL",
  ),
  marketItemsUrl: absoluteHttpsUrl(
    process.env.WF_MARKET_ITEMS_URL,
    "https://api.warframe.market/v2/items",
    "WF_MARKET_ITEMS_URL",
  ),
  marketUserAgent: process.env.WF_MARKET_USER_AGENT ?? "warframe-datasource-nnm/0.1.0 contact=local-operator",
  languagesRawBaseUrl: absoluteHttpsUrl(
    process.env.WF_LANGUAGES_RAW_BASE_URL,
    "https://raw.githubusercontent.com/calamity-inc/warframe-languages-bin-data/senpai",
    "WF_LANGUAGES_RAW_BASE_URL",
  ),
};

