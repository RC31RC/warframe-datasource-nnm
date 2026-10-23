import type { DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

/**
 * 用 languages 语言表反查，给 cleaned 数据递归追加中文（深度），不删除任何原字段：
 * - drop 的 `item` → `itemZh`
 * - 通用可本地化字段 `name`/`description`/`abilityName`/`passiveDescription` → 对应 `*Zh`
 * 未命中的保留原文，由下游用 data/languages 语言表兜底翻译。
 */
export function enrichNameZh(
  files: DatasetFileInput[],
  languagesFiles: DatasetFileInput[],
): DatasetFileInput[] {
  const { enToZh, enByKey, zhByKey } = buildLookups(languagesFiles);
  if (enToZh.size === 0 && Object.keys(zhByKey).length === 0) return files;
  return files.map((file) => {
    if (file.stage !== "cleaned" || !file.path.endsWith(".json") || /^(?:catalog\/i18n|localization)\//u.test(file.path)) return file;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
    } catch {
      return file;
    }
    const enriched = enrichValue(value, enToZh, enByKey, zhByKey);
    return { ...file, content: `${JSON.stringify(enriched, null, 2)}\n` };
  });
}

/** 可本地化字段 → 中文字段 的映射（追加 *Zh，保留原英文）。 */
const LOCALIZABLE_FIELDS = [
  ["name", "nameZh"],
  ["description", "descriptionZh"],
  ["abilityName", "abilityNameZh"],
  ["passiveDescription", "passiveDescriptionZh"],
  ["sender", "senderZh"], ["title", "titleZh"], ["body", "bodyZh"],
  ["hint", "hintZh"], ["tip", "tipZh"], ["text", "textZh"],
  ["stateName", "stateNameZh"], ["flavour", "flavourZh"],
  ["locTag", "locTagZh"],
] as const;

/** 递归处理任意嵌套结构（数组/dict），给可本地化字段追加中文。 */
function enrichValue(value: unknown, enToZh: Map<string, string>, enByKey: Record<string, string>, zhByKey: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => enrichValue(item, enToZh, enByKey, zhByKey));
  if (typeof value !== "object" || value === null) return value;
  const obj = value as JsonObject;
  const next: JsonObject = { ...obj };
  // drop 的 item 是英文可读名，用英文值反查中文。
  const item = obj.item;
  if (typeof item === "string") {
    const itemZh = enToZh.get(item);
    if (itemZh && itemZh !== item) next.itemZh = itemZh;
  }
  // 通用可本地化字段：语言 key 直接查中文，否则按英文值反查。
  for (const [field, zhField] of LOCALIZABLE_FIELDS) {
    const text = obj[field];
    if (typeof text !== "string" || text === "") continue;
    const enField = `${field}En`;
    if (!next[enField]) {
      const english = enByKey[text] ?? (!text.startsWith("/") ? text : "");
      if (english) next[enField] = english;
    }
    const existing = next[zhField];
    if (existing !== undefined && existing !== "") continue;
    const zh = text.startsWith("/Lotus/Language/") ? zhByKey[text] : enToZh.get(text);
    // zh !== text 避免冗余（官方中文名与英文相同时，如 "Yareli Prime"）。
    if (zh && zh !== text) next[zhField] = zh;
  }
  for (const key of Object.keys(next)) {
    const child = next[key];
    // Locale dictionaries already describe their own language; do not label Chinese as English.
    if (key !== "i18n" && key !== "translations" && typeof child === "object" && child !== null) {
      next[key] = enrichValue(child, enToZh, enByKey, zhByKey);
    }
  }
  return next;
}

function buildLookups(languagesFiles: DatasetFileInput[]): { enToZh: Map<string, string>; enByKey: Record<string, string>; zhByKey: Record<string, string> } {
  const en = readLanguagesMap(languagesFiles, "languages/en.json") ?? {};
  const zh = readLanguagesMap(languagesFiles, "languages/zh.json") ?? {};
  const candidates = new Map<string, Set<string>>();
  for (const [key, english] of Object.entries(en)) {
    const chinese = zh[key];
    if (!english || !chinese) continue;
    const values = candidates.get(english) ?? new Set<string>();
    values.add(chinese);
    candidates.set(english, values);
  }
  const enToZh = new Map<string, string>();
  for (const [english, values] of candidates) if (values.size === 1) enToZh.set(english, [...values][0] as string);
  return { enToZh, enByKey: en, zhByKey: zh };
}

function readLanguagesMap(files: DatasetFileInput[], path: string): Record<string, string> | undefined {
  const file = files.find((item) => item.path === path);
  if (!file) return undefined;
  const value = JSON.parse(Buffer.isBuffer(file.content) ? file.content.toString("utf8") : file.content) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, string>;
}
