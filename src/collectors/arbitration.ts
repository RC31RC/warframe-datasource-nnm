import { config } from "../core/config.js";
import { fetchBytes } from "../core/http.js";
import type { DatasetFileInput } from "../domain/contracts.js";

/**
 * 采集仲裁小时排期文本（browse.wf/arbys.txt）。
 *
 * arbys.txt 是社区维护的仲裁任务预测（每小时一条，格式 `epochSeconds,nodeReference`），
 * 非官方一手数据，发布时归入 community 层并标注来源。其解析依赖 worldstate 代码簿
 * （nodes.json 把节点键解析为可读名 + 任务类型 + 阵营 + 星系），因此生成顺序在代码簿之后。
 */
export async function collectArbitrationSchedule(now = new Date()): Promise<DatasetFileInput> {
  const url = config.arbitrationScheduleUrl;
  const bytes = await fetchBytes(url, {
    timeoutMs: config.requestTimeoutMs,
    maxBytes: config.maxResponseBytes,
    retries: config.requestRetries,
    headers: { accept: "text/plain" },
  });
  const text = bytes.toString("utf8");
  const recordCount = text.split(/\r?\n/u).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("//");
  }).length;
  return {
    stage: "raw",
    path: "arbitration/arbys.txt",
    content: text,
    recordCount,
    source: {
      project: "browse.wf",
      dataset: "arbitration-schedule",
      url,
      capturedAt: now.toISOString(),
      license: "community-curated prediction",
    },
  };
}
