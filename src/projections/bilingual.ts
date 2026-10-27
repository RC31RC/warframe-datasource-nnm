import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatasetFileInput } from "../domain/contracts.js";
import { canonicalProductPath } from "../publish/product-layout.js";
import { previewRedundantMissions } from "../analysis/redundant-missions.js";

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);
const zhField = (field: string) => `zh${field[0]?.toUpperCase() ?? ""}${field.slice(1)}`;
const text = (value: unknown, context: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`${context}: expected localized string`);
  return value;
};
const STATS_PRODUCTS = new Set(["upgrades/mods.json", "upgrades/arcanes.json", "upgrades/avionics.json", "upgrades/focus-upgrades.json"]);
export const LOCALIZATION_PRODUCTS = ["reference/item-localizations.json", "reference/ability-owner-localizations.json", "reference/upgrade-localizations.json"] as const;

/** These arrays are ordered display lines of the SAME field, not independently matched entities. */
export function bilingualLines(en: unknown, zh: unknown, context: string): Obj[] {
  for (const value of [en, zh]) if (value !== undefined && value !== null && !Array.isArray(value)) {
    throw new Error(`${context}: expected localized line array`);
  }
  const english = (en ?? []) as unknown[], chinese = (zh ?? []) as unknown[];
  return Array.from({ length: Math.max(english.length, chinese.length) }, (_, lineIndex) => ({
    lineIndex, text: text(english[lineIndex], context), zhText: text(chinese[lineIndex], context),
  }));
}

function bilingualAbilities(en: unknown, zh: unknown, context: string): Obj[] {
  const rows = new Map<string, { en?: Obj; zh?: Obj }>();
  for (const [locale, value] of [["en", en], ["zh", zh]] as const) {
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`${context}: expected abilities array`);
    for (const ability of value) {
      if (!object(ability) || typeof ability.abilityUniqueName !== "string") throw new Error(`${context}: missing ability identity`);
      if (Object.keys(ability).some((key) => !["abilityUniqueName", "abilityName", "description"].includes(key))) throw new Error(`${context}: unsupported ability field`);
      const pair = rows.get(ability.abilityUniqueName) ?? {};
      if (pair[locale]) throw new Error(`${context}: duplicate ability ${ability.abilityUniqueName}/${locale}`);
      pair[locale] = ability;
      rows.set(ability.abilityUniqueName, pair);
    }
  }
  return [...rows].map(([abilityUniqueName, pair]) => ({ abilityUniqueName,
    abilityName: text(pair.en?.abilityName, context), zhAbilityName: text(pair.zh?.abilityName, context),
    description: text(pair.en?.description, context), zhDescription: text(pair.zh?.description, context),
  }));
}

/** Three fixed DTO contracts; missing scalar text is null, never an array or an omitted field. */
export function splitItemLocalizations(value: unknown): Record<(typeof LOCALIZATION_PRODUCTS)[number], Obj> {
  if (!object(value)) throw new Error("Item localizations must be a keyed collection");
  const result: Record<(typeof LOCALIZATION_PRODUCTS)[number], Obj> = {
    "reference/item-localizations.json": {}, "reference/ability-owner-localizations.json": {}, "reference/upgrade-localizations.json": {},
  };
  for (const [uniqueName, raw] of Object.entries(value)) {
    if (!object(raw)) throw new Error(`${uniqueName}: expected localization record`);
    // A second pass over already normalized products must be byte-for-byte stable.
    if (!Object.hasOwn(raw, "en") && !Object.hasOwn(raw, "zh") && Object.hasOwn(raw, "zhName")) {
      result["reference/item-localizations.json"][uniqueName] = raw;
      continue;
    }
    const sourceFields = new Set(["en", "de", "es", "fr", "it", "ja", "ko", "pl", "pt", "ru", "tc", "th", "tr", "uk", "zh", "iconUrl"]);
    if (Object.keys(raw).some((field) => !sourceFields.has(field))) throw new Error(`${uniqueName}: unsupported localization record field`);
    const en = raw.en === undefined ? {} : raw.en, zh = raw.zh === undefined ? {} : raw.zh;
    if (!object(en) || !object(zh)) throw new Error(`${uniqueName}: expected locale object`);
    for (const locale of [en, zh]) if (Object.keys(locale).some((key) => !["name", "description", "abilities"].includes(key))) {
      throw new Error(`${uniqueName}: unsupported localization field`);
    }
    const abilities = Object.hasOwn(en, "abilities") || Object.hasOwn(zh, "abilities");
    const lines = Array.isArray(en.description) || Array.isArray(zh.description);
    if (abilities && lines) throw new Error(`${uniqueName}: ability owner has incompatible description shape`);
    const common = { uniqueName, name: text(en.name, uniqueName), zhName: text(zh.name, uniqueName), iconUrl: text(raw.iconUrl, uniqueName) };
    if (lines) {
      result["reference/upgrade-localizations.json"][uniqueName] = { ...common,
        descriptions: bilingualLines(en.description, zh.description, uniqueName) };
    } else {
      const row = { ...common, description: text(en.description, uniqueName), zhDescription: text(zh.description, uniqueName) };
      if (abilities) result["reference/ability-owner-localizations.json"][uniqueName] = { ...row,
        abilities: bilingualAbilities(en.abilities, zh.abilities, uniqueName) };
      else result["reference/item-localizations.json"][uniqueName] = row;
    }
  }
  return result;
}

/** Inline en/zh only at explicitly declared locale containers. Never interpret arbitrary IDs as locales. */
function inlineLocales(record: Obj, field: "i18n" | "translations", context: string): Obj {
  const locales = record[field];
  if (!object(locales)) throw new Error(`${context}: expected ${field} locale map`);
  const next = { ...record };
  delete next[field];
  const english = locales.en ?? {}, chinese = locales.zh ?? {};
  if (!object(english) || !object(chinese)) throw new Error(`${context}: invalid en/zh locale`);
  const keys = new Set([...Object.keys(english), ...Object.keys(chinese)]);
  // English Market responses may not contain zh. An exact official name is already enriched on this row.
  if (typeof record.nameZh === "string") keys.add("name");
  for (const key of keys) {
    const enValue = english[key], zhValue = chinese[key] ?? record[`${key}Zh`];
    for (const [target, value] of [[key, enValue], [zhField(key), zhValue]] as const) {
      if (value !== undefined && Object.hasOwn(next, target) && !isDeepStrictEqual(next[target], value)) {
        throw new Error(`${context}: conflicting localized field ${target}`);
      }
      if (value !== undefined) next[target] = value;
      else if (!Object.hasOwn(next, target)) next[target] = null;
    }
    const legacy = `${key}Zh`;
    if (Object.hasOwn(next, legacy)) {
      if (!isDeepStrictEqual(next[legacy], next[zhField(key)])) throw new Error(`${context}: conflicting ${legacy}`);
      delete next[legacy];
    }
  }
  return next;
}

function visit(value: unknown, file: string, path = "$"): unknown {
  if (Array.isArray(value)) return value.map((row) => visit(row, file, `${path}[]`));
  if (!object(value)) return value;
  let record = Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    key === "i18n" || key === "translations" ? child : visit(child, file, `${path}.${key}`)]));
  if (Object.hasOwn(record, "i18n")) record = inlineLocales(record, "i18n", `${file}:${path}`);
  if (Object.hasOwn(record, "translations")) record = inlineLocales(record, "translations", `${file}:${path}`);
  if (STATS_PRODUCTS.has(file) && (Object.hasOwn(record, "stats__stats") || Object.hasOwn(record, "statsZh__stats"))) {
    if (Object.hasOwn(record, "stats")) throw new Error(`${file}:${path}: stats field collision`);
    record.stats = bilingualLines(record.stats__stats, record.statsZh__stats, `${file}:${path}`);
    delete record.stats__stats; delete record.statsZh__stats;
  }
  return record;
}

function normalizeMods(value: unknown): unknown {
  if (!Array.isArray(value)) throw new Error("Mods must be an array");
  return value.map((raw) => {
    if (!object(raw)) throw new Error("Expected mod record");
    const { description, descriptionZh } = raw;
    const lines = Array.isArray(description) || Array.isArray(descriptionZh);
    if (lines && Object.hasOwn(raw, "descriptionLines")) throw new Error("Mod descriptionLines collision");
    return { ...raw, description: Array.isArray(description) ? null : text(description, "mod description"),
      descriptionZh: Array.isArray(descriptionZh) ? null : text(descriptionZh, "mod descriptionZh"),
      descriptionLines: lines ? bilingualLines(description, descriptionZh, "mod descriptions") : raw.descriptionLines ?? [] };
  });
}

/** Separate dictionary members from the enrichment array accidentally embedded in that dictionary. */
function normalizeEnemyAvatars(value: unknown): unknown {
  if (!object(value) || !object(value.agents)) return value;
  const agents = Object.fromEntries(Object.entries(value.agents).map(([id, raw]) => {
    if (!object(raw)) return [id, raw];
    const variants = Array.isArray(raw.avatarTypes) ? raw.avatarTypes : object(raw.avatarTypes)
      ? Object.entries(raw.avatarTypes).filter(([key]) => key !== "itemReferences").map(([variant, uniqueName]) => ({
        variant, uniqueName, itemReferences: ((raw.avatarTypes as Obj).itemReferences as unknown[] | undefined ?? [])
          .filter((ref) => object(ref) && ref.field === variant),
      })) : undefined;
    if (!variants) return [id, raw];
    const sourceRefs = object(raw.avatarTypes) ? raw.avatarTypes.itemReferences : undefined;
    if (sourceRefs !== undefined && !Array.isArray(sourceRefs)) throw new Error(`${id}: invalid avatar references`);
    let consumed = 0;
    const rows = variants.map((variant) => {
      if (!object(variant) || typeof variant.uniqueName !== "string" || typeof variant.variant !== "string") throw new Error(`${id}: invalid avatar variant`);
      if (!Object.hasOwn(variant, "itemReferences")) return variant;
      if (!Array.isArray(variant.itemReferences) || variant.itemReferences.length > 1) throw new Error(`${id}: avatar variant must have at most one resolved reference`);
      const { itemReferences, ...row } = variant;
      consumed += itemReferences.length;
      const reference = itemReferences[0];
      if (reference !== undefined) {
        if (!object(reference) || reference.uniqueName !== variant.uniqueName || reference.field !== variant.variant) throw new Error(`${id}: mismatched avatar reference`);
        for (const [field, child] of Object.entries(reference)) {
          const target = `reference__${field}`;
          if (Object.hasOwn(row, target)) throw new Error(`${id}: avatar reference field collision`);
          row[target] = child;
        }
      }
      return row;
    });
    if (Array.isArray(sourceRefs) && consumed !== sourceRefs.length) throw new Error(`${id}: unmatched avatar reference`);
    return [id, { ...raw, avatarTypes: rows }];
  }));
  return { ...value, agents };
}

function encoded(file: DatasetFileInput, path: string, value: unknown): DatasetFileInput {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  const records = Array.isArray(value) ? value.length : object(value) ? Object.keys(value).length : 1;
  return { ...file, path, content, recordCount: path === file.path ? file.recordCount ?? records : records, source: { ...file.source,
    upstreamRevision: createHash("sha256").update(content).digest("hex"), transformer: "warframe-datasource-nnm/bilingual-products@1" } };
}

/** Final publication contract. Earlier enrichers still consume their native en/zh objects. */
export function finalizeBilingualProducts(files: DatasetFileInput[]): DatasetFileInput[] {
  const output: DatasetFileInput[] = [];
  const destinations = new Set(files.map((file) => canonicalProductPath(file.path)));
  const languages = new Map(files.filter((file) => file.stage === "cleaned" && ["reference/language-en.json", "reference/language-zh.json"].includes(canonicalProductPath(file.path)))
    .map((file) => [canonicalProductPath(file.path), file]));
  let mergedLanguage = false;
  for (const file of files) {
    if (file.stage !== "cleaned") { output.push(file); continue; }
    const path = canonicalProductPath(file.path);
    if (languages.size === 2 && languages.has(path)) {
      if (mergedLanguage) continue;
      if (destinations.has("reference/language-strings.json")) throw new Error("Conflicting bilingual language dictionary destination");
      const enFile = languages.get("reference/language-en.json")!, zhFile = languages.get("reference/language-zh.json")!;
      const en: unknown = JSON.parse(String(enFile.content)), zh: unknown = JSON.parse(String(zhFile.content));
      if (!object(en) || !object(zh)) throw new Error("Expected keyed language dictionaries");
      const rows = Object.fromEntries([...new Set([...Object.keys(en), ...Object.keys(zh)])].sort().map((key) => [key,
        { key, text: text(en[key], key), zhText: text(zh[key], key) }]));
      const merged = encoded(enFile, "reference/language-strings.json", rows);
      merged.source.derivedFrom = [...new Set([...(enFile.source.derivedFrom ?? []), ...(zhFile.source.derivedFrom ?? [])])];
      output.push(merged); mergedLanguage = true; continue;
    }
    if (path === "reference/language-en.json" || path === "reference/language-zh.json" || path === "reference/language-strings.json") { output.push(file); continue; }
    const original: unknown = JSON.parse(String(file.content));
    if (path === "reference/item-localizations.json") {
      const parts = splitItemLocalizations(original);
      for (const target of LOCALIZATION_PRODUCTS) {
        if (target !== path && destinations.has(target)) {
          if (Object.keys(parts[target]).length) throw new Error(`Conflicting localization destination: ${target}`);
          continue;
        }
        output.push({ ...encoded(file, target === path ? file.path : target, parts[target]), recordCount: Object.keys(parts[target]).length });
      }
      continue;
    }
    let value = original;
    if (path === "world/tilesets.json") {
      const result = previewRedundantMissions(value);
      if (result.checked !== result.removable) throw new Error("missionDefinitions must retain every original mission field before removing missions");
      value = result.value;
    }
    value = visit(value, path);
    if (path === "upgrades/mods.json") value = normalizeMods(value);
    if (path === "world/enemies.json") value = normalizeEnemyAvatars(value);
    output.push(isDeepStrictEqual(original, value) ? file : encoded(file, file.path, value));
  }
  return output;
}
