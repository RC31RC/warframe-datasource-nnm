import { gzipSync } from "node:zlib";

/** Stable header across platforms: no timestamp and OS=unknown (the OS field cannot be omitted). */
export function stableGzip(bytes: Buffer): Buffer {
  const compressed = gzipSync(bytes, { level: 9 });
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 0xff;
  return compressed;
}
