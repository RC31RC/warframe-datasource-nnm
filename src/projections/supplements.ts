import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatasetFileInput } from "../domain/contracts.js";
import { enrichNameZh } from "./enrich.js";
import { consolidateRecipes } from "./recipes.js";
import { normalizeRanks } from "./public-export.js";
import { object, read } from "./identity.js";

type Obj = Record<string, unknown>;
const DOMAINS = [
  ["Resources", "resources/items.json"], ["Customs", "cosmetics/catalog.json"],
  ["Flavour", "cosmetics/flavour.json"], ["Keys", "quests/keys.json"],
  ["Gear", "equipment/gear.json"], ["Sentinels", "companions/sentinels.json"],
  ["Drones", "equipment/resource-drones.json"], ["FusionBundles", "commerce/fusion-bundles.json"],
] as const;

/** Union complementary official exports by exact identity; published localized fields take precedence. */
export function supplementCatalogs(catalog: DatasetFileInput[], publicExport: DatasetFileInput[], plus: DatasetFileInput[], languages: DatasetFileInput[]): DatasetFileInput[] {
  const inputs = new Map([...publicExport, ...plus].filter((file) => file.stage === "raw").map((file) => [file.path, file]));
  const i18nFile = catalog.find((file) => file.path === "catalog/i18n/items.json");
  if (!i18nFile) throw new Error("Missing item localization catalog");
  const i18n = object(read(i18nFile));
  const output = [...catalog];
  const derived = new Set(i18nFile.source.derivedFrom ?? []);
  for (const [domain, path] of DOMAINS) {
    const plusFile = inputs.get(`plus/Export${domain}.json`);
    const enFile = inputs.get(`public-export/en/Export${domain}_en.json`);
    if (!plusFile && !enFile) continue;
    const entities: Obj = {};
    if (plusFile) {
      derived.add(plusFile.path);
      const localized = enrichNameZh([{ ...plusFile, stage: "cleaned" }], languages)[0]!;
      for (const [id, value] of Object.entries(object(read(localized)))) {
        entities[id] = { ...object(value), uniqueName: id, recordKey: id };
      }
    }
    const dependencies = plusFile ? [plusFile.path] : [];
    for (const [inputPath, file] of inputs) {
      const match = new RegExp(`^public-export/([a-z]{2})/Export${domain}_[a-z]{2}\\.json$`, "u").exec(inputPath);
      if (!match) continue;
      dependencies.push(inputPath); derived.add(inputPath);
      const locale = match[1]!;
      const records = object(read(file))[`Export${domain}`];
      if (!Array.isArray(records)) throw new Error(`Expected Export${domain} in ${inputPath}`);
      const seen = new Map<string, Obj>();
      for (const raw of records) {
        const record = object(raw), id = String(record.uniqueName ?? "");
        if (!id.startsWith("/")) throw new Error(`Missing identity in ${inputPath}`);
        if (seen.has(id)) {
          if (!isDeepStrictEqual(seen.get(id), record)) throw new Error(`Conflicting duplicate identity in ${inputPath}: ${id}`);
          continue;
        }
        seen.set(id, record);
        const entry = object(i18n[id]);
        const localized: Obj = { ...object(entry[locale]) };
        for (const field of ["name", "description"]) if (typeof record[field] === "string") localized[field] = record[field];
        i18n[id] = { ...entry, [locale]: localized };
        if (locale === "en") entities[id] = { ...object(entities[id]), ...record, recordKey: id, nameEn: record.name };
        if (locale === "zh") entities[id] = { ...object(entities[id]), nameZh: record.name, ...(typeof record.description === "string" ? { descriptionZh: record.description } : {}) };
      }
    }
    for (const [id, raw] of Object.entries(entities)) {
      const record = object(raw), entry = object(i18n[id]);
      const name = record.nameEn ?? record.name;
      const en = { ...object(entry.en) }, zh = { ...object(entry.zh) };
      if (!en.name && typeof name === "string" && !name.startsWith("/")) en.name = name;
      if (!zh.name && record.nameZh) zh.name = record.nameZh;
      i18n[id] = { ...entry, en, zh };
    }
    const content = `${JSON.stringify(entities, null, 2)}\n`;
    const base = enFile ?? plusFile!;
    output.push({ stage: "cleaned", path, content, recordCount: Object.keys(entities).length, source: {
      ...base.source, dataset: path, derivedFrom: dependencies, transformer: "warframe-datasource-nnm/complementary-catalog@1", upstreamRevision: createHash("sha256").update(content).digest("hex"),
    } });
  }
  // Other Plus domains also provide exact localized identities absent from Public Export.
  for (const file of plus.filter((file) => file.stage === "raw" && !/Export(?:Images|Rewards|TextIcons|DojoRecipes)\.json$/u.test(file.path))) {
    const localized = enrichNameZh([{ ...file, stage: "cleaned" }], languages)[0]!;
    for (const [id, raw] of Object.entries(object(read(localized)))) {
      if (!id.startsWith("/Lotus/") || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const record = object(raw), name = record.nameEn ?? record.name;
      if (typeof name !== "string" || name.startsWith("/")) continue;
      const entry = object(i18n[id]), en = { ...object(entry.en) }, zh = { ...object(entry.zh) };
      if (!en.name) en.name = name;
      if (!zh.name && record.nameZh) zh.name = record.nameZh;
      i18n[id] = { ...entry, en, zh };
      derived.add(file.path);
    }
  }
  // Complement existing entities by exact ID; keep the localized Public Export value on conflicts.
  for (const [domain, path] of [
    ["Weapons", "catalog/equipment/weapons.json"], ["Warframes", "catalog/equipment/warframes.json"],
    ["Warframes", "catalog/equipment/archwings.json"],
    ["Abilities", "catalog/equipment/abilities.json"],
    ["RailjackWeapons", "catalog/equipment/railjack-weapons.json"], ["Upgrades", "catalog/upgrades/mods.json"],
    ["Arcanes", "catalog/upgrades/arcanes.json"], ["FocusUpgrades", "catalog/upgrades/focus-upgrades.json"],
    ["Avionics", "catalog/upgrades/avionics.json"], ["ModSet", "catalog/upgrades/mod-sets.json"],
    ["Recipes", "catalog/craft/recipes.json"],
  ]) {
    const plusFile = inputs.get(`plus/Export${domain}.json`);
    const targetIndex = output.findIndex((file) => file.path === path);
    if ((!plusFile && domain !== "Recipes") || targetIndex < 0) continue;
    const target = output[targetIndex]!;
    const root = read(target), isArray = Array.isArray(root);
    const current: Record<string, Obj> = {};
    if (isArray) for (const raw of root as unknown[]) {
      const record = object(raw), id = String(record.uniqueName ?? "");
      if (!id.startsWith("/")) throw new Error(`Missing identity in ${path}`);
      if (current[id] && !isDeepStrictEqual(current[id], record)) {
        throw new Error(`Conflicting duplicate identity in ${path}: ${id}`);
      }
      current[id] = record;
    }
    else Object.assign(current, object(root));
    const localized = plusFile ? enrichNameZh([{ ...plusFile, stage: "cleaned" }], languages)[0] : undefined;
    for (const [id, raw] of Object.entries(localized ? object(read(localized)) : {})) {
      const isUpgrade = ["Upgrades", "Arcanes", "FocusUpgrades", "Avionics", "ModSet"].includes(domain!);
      const extra = isUpgrade ? normalizeRanks(object(raw), domain === "ModSet") : object(raw);
      const existing = current[id];
      if (domain === "Warframes" && path!.endsWith("/archwings.json") !== (extra.productCategory === "SpaceSuits")) continue;
      const namedExtra = typeof extra.nameEn === "string"
        ? { ...extra, nameKey: extra.name, name: extra.nameEn }
        : extra;
      if (existing) current[id] = { ...namedExtra, ...existing };
      else current[id] = { ...namedExtra, uniqueName: id, recordKey: id };
      if (existing && Array.isArray(existing.abilities) && Array.isArray(extra.abilities)) {
        const abilities = new Map(extra.abilities.map((raw) => [String(object(raw).uniqueName), object(raw)]));
        current[id]!.abilities = existing.abilities.map((raw) => {
          const ability = object(raw);
          return { ...abilities.get(String(ability.uniqueName ?? ability.abilityUniqueName)), ...ability };
        });
      }
      if (domain === "Recipes") {
        const recipe = current[id]!;
        const special = recipe.secretIngredientAction ?? (Array.isArray(recipe.secretIngredients) && recipe.secretIngredients.length ? "special_ingredients" : undefined);
        recipe.recipeKind = special ? "special_action" : "ordinary";
        recipe.quantityBasis = "per_build";
        if (special) recipe.actionKey = special;
      }
    }
    if (domain === "Recipes") for (const [id, recipe] of Object.entries(current)) {
      const product = object(i18n[String(recipe.resultType)]);
      const entry = object(i18n[id]);
      for (const [locale, suffix] of [["en", " Blueprint"], ["zh", "蓝图"]]) {
        const productName = object(product[locale!]).name;
        if ((recipe.recipeKind === "ordinary" || id.endsWith("Blueprint")) && typeof productName === "string" && !object(entry[locale!]).name) {
          entry[locale!] = { ...object(entry[locale!]), name: `${productName}${suffix}` };
        }
      }
      if (Object.keys(entry).length) i18n[id] = entry;
      const reference = (uniqueName: string, previous: unknown = {}): Obj => {
        const localized = object(i18n[uniqueName]);
        return { uniqueName, name: object(localized.en).name ?? "", nameZh: object(localized.zh).name ?? "", ...object(previous) };
      };
      if (typeof recipe.resultType === "string") recipe.resultItem = reference(recipe.resultType, recipe.resultItem);
      if (Array.isArray(recipe.ingredients)) recipe.ingredients = recipe.ingredients.map((raw, index) => {
        const ingredient = object(raw);
        return typeof ingredient.ItemType === "string" ? { ...ingredient, ingredientOrder: index, item: reference(ingredient.ItemType, ingredient.item) } : ingredient;
      });
    }
    const result = isArray ? Object.values(current) : consolidateRecipes(current);
    output[targetIndex] = { ...target, content: `${JSON.stringify(result, null, 2)}\n`, recordCount: Object.keys(result).length,
      source: { ...target.source, derivedFrom: [...new Set([...(target.source.derivedFrom ?? []), ...(plusFile ? [plusFile.path] : [])])] } };
  }
  const dojo = inputs.get("plus/ExportDojoRecipes.json");
  if (dojo) output.push({ ...dojo, stage: "cleaned", path: "crafting/dojo-recipes.json", source: { ...dojo.source, derivedFrom: [dojo.path] } });
  return output.map((file) => file.path !== i18nFile.path ? file : { ...file, content: `${JSON.stringify(i18n, null, 2)}\n`, recordCount: Object.keys(i18n).length, source: { ...file.source, derivedFrom: [...derived] } });
}
