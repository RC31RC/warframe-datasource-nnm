import { gunzipSync } from "node:zlib";

export function parseGzipJson<T = unknown>(bytes: Uint8Array): T {
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as T;
}

/** Business projections still identify products by their logical .json path. */
export function logicalProductPath(path: string): string {
  return path.endsWith(".json.gz") ? path.slice(0, -3) : path;
}
