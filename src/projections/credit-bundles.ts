import type { DatasetFileInput } from "../domain/contracts.js";
import { object, read } from "./identity.js";

/** 已确认的资源 ID/语言键绑定；金额和图标只接受采集到的对象属性。 */
export function supplementCreditBundles(plus: DatasetFileInput[], languages: DatasetFileInput[]): DatasetFileInput[] {
  const id = "/Lotus/Types/PickUps/Credits/50000Credits";
  const key = "/Lotus/Language/Currency/50000Credits";
  const en = languages.find((file) => file.path === "languages/en.json");
  const zh = languages.find((file) => file.path === "languages/zh.json");
  const nameEn = en ? object(read(en))[key] : undefined;
  const nameZh = zh ? object(read(zh))[key] : undefined;
  if (typeof nameEn !== "string" && typeof nameZh !== "string") return plus;
  return plus.map((file) => {
    if (file.path !== "plus/creditbundles.json" || file.stage !== "cleaned") return file;
    const root = object(read(file)), existing = object(root[id]);
    const entry = { uniqueName: id, name: key, nameKey: key,
      ...(nameEn ? { nameEn } : {}), ...(nameZh ? { nameZh } : {}), ...existing,
      definitionStatus: typeof existing.credits === "number" ? "complete" : "localized_definition_only" };
    return { ...file, content: `${JSON.stringify({ ...root, [id]: entry }, null, 2)}\n`,
      recordCount: Object.keys({ ...root, [id]: entry }).length,
      source: { ...file.source, derivedFrom: [...new Set([...(file.source.derivedFrom ?? []), ...[en?.path, zh?.path].filter((x): x is string => !!x)])] } };
  });
}
