export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface SourceMetadata {
  project: string;
  dataset: string;
  url: string;
  capturedAt: string;
  upstreamRevision?: string;
  transformer?: string;
  derivedFrom?: string[];
  license?: string;
}

/** 数据阶段：raw = 采集到的原始输入（写入 tmp/），cleaned = 清洗后的发布产物（写入 data/）。 */
export type DatasetStage = "raw" | "cleaned";

export interface DatasetFileInput {
  stage: DatasetStage;
  path: string;
  content: Buffer | string;
  source: SourceMetadata;
  recordCount?: number;
}

export interface DatasetFileEntry {
  path: string;
  sha256: string;
  bytes: number;
  mediaType: "application/json" | "text/plain" | "text/html";
  source: SourceMetadata;
  recordCount?: number;
}

export interface DatasetManifest {
  schemaVersion: 1;
  buildId: string;
  createdAt: string;
  producer: "warframe-datasource-nnm";
  files: DatasetFileEntry[];
}
