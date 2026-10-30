import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { config } from "../core/config.js";
import { fetchBytes, fetchJson, HttpStatusError } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

export const REQUIRED_EXPORTS = [
  "ExportWarframes",
  "ExportWeapons",
  "ExportUpgrades",
  "ExportRelicArcane",
  "ExportRegions",
  "ExportRecipes",
] as const;
export const REQUIRED_SHARED_EXPORTS = ["ExportManifest"] as const;

/** Only English and Simplified Chinese are acquired and published. */
export const LOCALES = ["en", "zh"] as const;
interface IndexEntry {
  fileName: string;
  upstreamRevision: string;
}

export async function collectPublicExport(now = new Date()): Promise<DatasetFileInput[]> {
  const files: DatasetFileInput[] = [];
  const capturedAt = now.toISOString();
  const downloadJobs: Array<{
    locale: (typeof LOCALES)[number] | "shared";
    entry: IndexEntry;
    exportName: string;
  }> = [];

  for (const locale of LOCALES) {
    const { compressed, indexUrl } = await fetchPublicExportIndex(locale);
    const indexText = await decompressIndex(compressed);
    const entries = parsePublicExportIndex(indexText);
    for (const exportName of REQUIRED_EXPORTS) {
      if (!entries.has(`${exportName}_${locale}.json`)) {
        throw new Error(`Public Export index ${locale} is missing ${exportName}_${locale}.json`);
      }
    }
    const localizedEntries = [...entries.values()].filter((entry) =>
      entry.fileName.endsWith(`_${locale}.json`) && !entry.fileName.startsWith("ExportManifest_"),
    );
    const sharedEntries = locale === "en"
      ? [...entries.values()].filter((entry) => !/_([a-z]{2})\.json$/u.test(entry.fileName))
      : [];
    if (locale === "en") {
      for (const exportName of REQUIRED_SHARED_EXPORTS) {
        if (!entries.has(`${exportName}.json`)) throw new Error(`Public Export index is missing ${exportName}.json`);
      }
    }

    files.push({
      stage: "raw",
      path: `public-export/index/${locale}.json`,
      content: `${JSON.stringify({
        locale,
        indexSha256: createHash("sha256").update(compressed).digest("hex"),
        entries: [...entries.values()].map(({ fileName, upstreamRevision }) => ({ fileName, upstreamRevision })),
      }, null, 2)}\n`,
      recordCount: entries.size,
      source: {
        project: "Digital Extremes Public Export",
        dataset: `index/${locale}`,
        url: indexUrl,
        capturedAt,
        upstreamRevision: createHash("sha256").update(compressed).digest("hex"),
      },
    });
    for (const entry of localizedEntries) {
      downloadJobs.push({
        locale,
        entry,
        exportName: entry.fileName.slice(0, -`_${locale}.json`.length),
      });
    }
    for (const entry of sharedEntries) {
      downloadJobs.push({
        locale: "shared",
        entry,
        exportName: entry.fileName.slice(0, -".json".length),
      });
    }
  }

  const downloaded = await mapLimit(downloadJobs, 4, async ({ locale, entry, exportName }) => {
    const url = config.publicExportManifestUrl.replace("{file}", `${entry.fileName}!${entry.upstreamRevision}`);
    const response = await fetchJson(url, {
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxResponseBytes,
      retries: config.requestRetries,
    });
    if (REQUIRED_EXPORTS.includes(exportName as (typeof REQUIRED_EXPORTS)[number])) {
      assertRequiredExportPayload(response.value, exportName, url);
    }
    const recordCount = getRecordCount(response.value, exportName);
    return {
      stage: "raw",
      path: locale === "shared"
        ? `public-export/shared/${entry.fileName}`
        : `public-export/${locale}/${entry.fileName}`,
      content: response.bytes,
      ...(recordCount === undefined ? {} : { recordCount }),
      source: {
        project: "Digital Extremes Public Export",
        dataset: locale === "shared" ? exportName : `${exportName}/${locale}`,
        url,
        capturedAt,
        upstreamRevision: entry.upstreamRevision,
      },
    } satisfies DatasetFileInput;
  });
  files.push(...downloaded);
  return files;
}

/** Alternate official host only when the primary rejects this runner with HTTP 403. */
export async function fetchPublicExportIndex(locale: (typeof LOCALES)[number]): Promise<{ compressed: Buffer; indexUrl: string }> {
  const primary = config.publicExportIndexUrl.replace("{language}", locale);
  const fallback = config.publicExportIndexFallbackUrl.replace("{language}", locale);
  const options = {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: 16 * 1024 * 1024,
    retries: config.requestRetries,
    headers: { accept: "application/x-lzma", "accept-encoding": "identity" },
  };
  try {
    return { compressed: await fetchBytes(primary, options), indexUrl: primary };
  } catch (error) {
    if (!(error instanceof HttpStatusError) || error.status !== 403 || primary === fallback) throw error;
    console.warn(`Public Export index ${locale} returned HTTP 403 from ${primary}; trying ${fallback}`);
    return { compressed: await fetchBytes(fallback, options), indexUrl: fallback };
  }
}

export function parsePublicExportIndex(text: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("!");
    if (separator <= 0 || separator === line.length - 1) continue;
    const fileName = line.slice(0, separator).trim();
    const upstreamRevision = line.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+(?:_[a-z]{2})?\.json$/u.test(fileName)) continue;
    if (!/^[A-Za-z0-9:+._=-]+$/u.test(upstreamRevision)) continue;
    if (entries.has(fileName)) throw new Error(`Duplicate Public Export index entry: ${fileName}`);
    entries.set(fileName, { fileName, upstreamRevision });
  }
  if (entries.size === 0) throw new Error("Public Export index contains no valid file entries");
  return entries;
}

export async function decompressIndex(compressed: Buffer): Promise<string> {
  if (compressed.length < 13) throw new Error("Public Export index is too short to be compressed data");
  const xz = compressed.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]));
  const properties = compressed[0] ?? 0xff;
  const dictionarySize = compressed.readUInt32LE(1);
  const legacyLzma = properties <= 224 && dictionarySize >= 4096 && dictionarySize <= 128 * 1024 * 1024;
  if (!xz && !legacyLzma) throw new Error("Public Export index has an unsupported compression header");
  // liblzma handles both XZ and legacy LZMA-alone containers returned by the endpoint.
  const { default: native } = await import("lzma-native");
  const decoder = native.createDecompressor({ memlimit: 128 * 1024 * 1024 });
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of Readable.from([compressed]).pipe(decoder)) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 16 * 1024 * 1024) {
      decoder.destroy(new Error("Public Export index exceeds decompressed size limit"));
      throw new Error("Public Export index exceeds decompressed size limit");
    }
    chunks.push(bytes);
  }
  if (total === 0) throw new Error("Public Export index decompressed to empty content");
  const text = Buffer.concat(chunks, total).toString("utf8");
  if (text.includes("\u0000")) throw new Error("Public Export index did not decode as UTF-8 text");
  return text;
}

function assertRequiredExportPayload(value: unknown, exportName: string, url: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Unexpected Public Export payload for ${exportName}: ${url}`);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record[exportName])) {
    throw new Error(`Public Export payload lacks ${exportName} array: ${url}`);
  }
}

function getRecordCount(value: unknown, exportName: string): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const records = (value as Record<string, unknown>)[exportName];
  return Array.isArray(records) ? records.length : undefined;
}

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) throw new Error("Concurrent collection index out of range");
      result[index] = await mapper(item);
    }
  });
  await Promise.all(workers);
  return result;
}
