import { createHash } from "node:crypto";
import JSON5 from "json5";
import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

const PLATFORMS = ["PC", "PS4", "XB1", "SWI"] as const;

/**
 * Digital Extremes publishes weekly riven trading statistics as a JavaScript
 * object literal (unquoted keys, single-quoted strings) rather than strict
 * JSON. Parse it with JSON5 and never evaluate upstream code.
 */
export async function collectWeeklyRivens(now = new Date()): Promise<DatasetFileInput[]> {
  const capturedAt = now.toISOString();
  const output: DatasetFileInput[] = [];
  for (const platform of PLATFORMS) {
    const url = config.weeklyRivensUrl.replace("{platform}", platform);
    const bytes = await fetchBytes(url, {
      timeoutMs: config.requestTimeoutMs,
      maxBytes: config.maxResponseBytes,
      retries: config.requestRetries,
      headers: { accept: "application/json", "accept-encoding": "identity" },
    });
    const records = parseWeeklyRivens(bytes.toString("utf8"), platform);
    const rawPath = `weekly-rivens/${platform}.txt`;
    const upstreamRevision = createHash("sha256").update(bytes).digest("hex");
    output.push({
      stage: "raw",
      path: rawPath,
      content: bytes,
      source: {
        project: "Digital Extremes Weekly Rivens",
        dataset: `riven/weekly/${platform}`,
        url,
        capturedAt,
        upstreamRevision,
      },
    });
    output.push({
      stage: "cleaned",
      path: `riven/weekly-${platform.toLowerCase()}.json`,
      content: `${JSON.stringify(records, null, 2)}\n`,
      recordCount: records.length,
      source: {
        project: "Digital Extremes Weekly Rivens",
        dataset: `riven/weekly/${platform}`,
        url,
        capturedAt,
        upstreamRevision,
        transformer: "warframe-datasource-nnm/weekly-rivens-projection@1",
        derivedFrom: [rawPath],
      },
    });
  }
  return output;
}

export function parseWeeklyRivens(payload: string, platform: string): Record<string, unknown>[] {
  let value: unknown;
  try {
    value = JSON5.parse(payload) as unknown;
  } catch (error) {
    throw new Error(`Invalid weekly riven payload for ${platform}`, { cause: error });
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Weekly riven payload for ${platform} must be a nonempty array`);
  }
  const identities = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const raw of value) {
    const row = asObject(raw, `${platform} weekly riven`);
    const itemType = text(row, "itemType");
    if (itemType === undefined || itemType.trim() === "") {
      throw new Error(`Weekly riven record for ${platform} lacks itemType`);
    }
    if (typeof row.rerolled !== "boolean") {
      throw new Error(`Weekly riven record for ${platform} lacks boolean rerolled`);
    }
    const compatibility = row.compatibility === null || row.compatibility === undefined
      ? null : text(row, "compatibility");
    if (compatibility !== null && compatibility === undefined) {
      throw new Error(`Weekly riven record for ${platform} has invalid compatibility`);
    }
    const identity = `${itemType}\u0000${compatibility ?? ""}\u0000${row.rerolled}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate weekly riven identity for ${platform}: ${itemType}`);
    }
    identities.add(identity);
    records.push({
      itemType,
      compatibility,
      rerolled: row.rerolled,
      avg: nonnegativeNumber(row, "avg", platform),
      stddev: nonnegativeNumber(row, "stddev", platform),
      min: nonnegativeNumber(row, "min", platform),
      max: nonnegativeNumber(row, "max", platform),
      pop: nonnegativeNumber(row, "pop", platform),
      median: nonnegativeNumber(row, "median", platform),
    });
  }
  return records;
}

function nonnegativeNumber(row: Record<string, unknown>, key: string, platform: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Weekly riven record for ${platform} has invalid ${key}`);
  }
  return value;
}

function text(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} record must be an object`);
  }
  return value as Record<string, unknown>;
}
