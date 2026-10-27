import { createHash } from "node:crypto";
import type { JsonValue, DatasetFileInput } from "../domain/contracts.js";

type JsonObject = Record<string, unknown>;

import { LOCALES } from "../collectors/public-export.js";

// 主投影（数值结构/英文名）只用 en 版本；多语言翻译由 appendTranslations 循环 LOCALES 读取。
const INPUTS = {
  warframes: "public-export/en/ExportWarframes_en.json",
  weapons: "public-export/en/ExportWeapons_en.json",
  upgrades: "public-export/en/ExportUpgrades_en.json",
  relicArcane: "public-export/en/ExportRelicArcane_en.json",
  regions: "public-export/en/ExportRegions_en.json",
  recipes: "public-export/en/ExportRecipes_en.json",
} as const;

function localizedPath(locale: string, exportName: string): string {
  return `public-export/${locale}/Export${exportName}_${locale}.json`;
}

export function projectPublicExport(rawFiles: DatasetFileInput[]): DatasetFileInput[] {
  const sourceByPath = new Map(rawFiles.map((file) => [file.path, file]));
  const exports = Object.fromEntries(Object.entries(INPUTS).map(([key, path]) => [
    key,
    readExport(sourceByPath, path),
  ])) as Record<keyof typeof INPUTS, JsonObject>;
  const output: DatasetFileInput[] = [];

  // 中文记录索引（uniqueName → zh 完整记录）与图标/头像索引，给 catalog 实体对齐内联中文 + 图标（深度）。
  const enRecords = readLocaleRecords(sourceByPath, "en");
  const zhRecords = readLocaleRecords(sourceByPath, "zh");
  const standaloneAbilityTranslations = readAbilityTranslations(sourceByPath, "zh");
  const { iconUrls, avatarUrls } = readIconUrls(sourceByPath);
  const enrich = (records: JsonObject[]) => enrichRecords(records, zhRecords, iconUrls, avatarUrls);

  const warframes = requiredArray(exports.warframes, "ExportWarframes");
  const abilities = new Map<string, JsonObject>();
  const abilityOwners = new Map<string, Set<string>>();
  const frames = warframes.filter((record) => text(record, "productCategory") !== "SpaceSuits");
  const archwings = warframes.filter((record) => text(record, "productCategory") === "SpaceSuits");
  for (const [records, ownerType] of [[frames, "warframe"], [archwings, "archwing"]] as const) {
    for (const raw of records) {
      const owner = identified(raw, "equipment");
      const ownerKey = owner.recordKey as string;
      const slots = raw.abilities;
      if (slots === undefined) continue;
      if (!Array.isArray(slots)) throw new Error(`${ownerKey}: abilities must be an array`);
      slots.forEach((slot, index) => {
        const ability = normalizeAbility(slot, `${ownerKey}: ability ${index}`);
        addUnique(abilities, ability.recordKey as string, ability, "ability");
        const owners = abilityOwners.get(ability.recordKey as string) ?? new Set<string>();
        owners.add(ownerKey);
        abilityOwners.set(ability.recordKey as string, owners);
      });
    }
  }
  if (exports.warframes.ExportAbilities !== undefined) {
    for (const value of requiredArray(exports.warframes, "ExportAbilities")) {
      const ability = normalizeAbility(value, "ExportAbilities");
      addUnique(abilities, ability.recordKey as string, ability, "ability");
    }
  }

  const projectedFrames = enrich(normalizeOwnerAbilities(frames, "warframe"));
  const projectedArchwings = enrich(normalizeOwnerAbilities(archwings, "archwing"));
  appendArrayProjection(output, sourceByPath, "catalog/equipment/warframes.json", projectedFrames, [INPUTS.warframes]);
  appendArrayProjection(output, sourceByPath, "catalog/equipment/archwings.json", projectedArchwings, [INPUTS.warframes]);

  const abilityIndex = new Map<string, JsonObject>();
  for (const parent of [...projectedFrames, ...projectedArchwings]) {
    const parentKey = text(parent, "recordKey") ?? "";
    const slots = Array.isArray(parent.abilities) ? parent.abilities : [];
    for (const rawAbility of slots) {
      const ability = object(rawAbility, `${parentKey}: projected ability`);
      const key = text(ability, "recordKey");
      if (!key) throw new Error(`${parentKey}: projected ability lacks recordKey`);
      const value = { ...ability, ownerBkeys: [...(abilityOwners.get(key) ?? [])].sort() };
      addUnique(abilityIndex, key, value, "projected ability");
    }
  }
  for (const [key, ability] of abilities) {
    if (abilityIndex.has(key)) continue;
    const [localized] = enrich([ability]);
    const abilityZh = standaloneAbilityTranslations.get(key);
    const abilityIconUrl = iconUrls.get(key);
    abilityIndex.set(key, {
      ...localized,
      ...(abilityZh?.name ? { nameZh: abilityZh.name, abilityNameZh: abilityZh.name } : {}),
      ...(abilityZh?.description ? { descriptionZh: abilityZh.description } : {}),
      ...(abilityIconUrl ? { abilityIconUrl, iconUrl: abilityIconUrl } : {}),
      ownerBkeys: [],
    });
  }
  appendArrayProjection(output, sourceByPath, "catalog/equipment/abilities.json", [...abilityIndex.values()], [INPUTS.warframes]);

  const weapons = requiredArray(exports.weapons, "ExportWeapons").map((value) => identified(value, "weapon"));
  appendArrayProjection(output, sourceByPath, "catalog/equipment/weapons.json", enrich(weapons), [INPUTS.weapons]);
  if (exports.weapons.ExportRailjackWeapons !== undefined) {
    const railjack = requiredArray(exports.weapons, "ExportRailjackWeapons").map((value) => identified(value, "railjack weapon"));
    appendArrayProjection(output, sourceByPath, "catalog/equipment/railjack-weapons.json", enrich(railjack), [INPUTS.weapons]);
  }

  const upgradeSources = [
    { key: "ExportUpgrades", path: "catalog/upgrades/mods.json", ownerType: "mod" },
    { key: "ExportFocusUpgrades", path: "catalog/upgrades/focus-upgrades.json", ownerType: "focus" },
    { key: "ExportAvionics", path: "catalog/upgrades/avionics.json", ownerType: "avionic" },
  ] as const;
  for (const upgradeSource of upgradeSources) {
    const raw = exports.upgrades[upgradeSource.key];
    if (raw === undefined) continue;
    const parents = requiredArray(exports.upgrades, upgradeSource.key).map((value) => ({
      ...identified(value, upgradeSource.key),
      upgradeType: upgradeSource.ownerType,
    }));
    appendArrayProjection(output, sourceByPath, upgradeSource.path,
      enrich(parents).map((record) => normalizeRanks(record, false)), [INPUTS.upgrades]);
  }

  if (exports.upgrades.ExportModSet !== undefined) {
    const modSets = requiredArray(exports.upgrades, "ExportModSet").map((value) => {
      const parent = identified(value, "ExportModSet");
      const stats = parent.stats;
      if (stats !== undefined && !Array.isArray(stats)) throw new Error(`${parent.recordKey}: set stats must be an array`);
      return {
        ...parent,
        ...(Array.isArray(stats) ? { levelStats: stats } : {}),
      };
    });
    appendArrayProjection(output, sourceByPath, "catalog/upgrades/mod-sets.json",
      enrich(modSets).map((record) => normalizeRanks(record, true)), [INPUTS.upgrades]);
  }

  const relicArcane = requiredArray(exports.relicArcane, "ExportRelicArcane");
  const arcanes = relicArcane.filter((record) => text(record, "uniqueName")?.startsWith("/Lotus/Upgrades/CosmeticEnhancers/") === true)
    .map((value) => identified(value, "arcane"));
  const relicCount = relicArcane.filter((record) => text(record, "uniqueName")?.includes("/Projections/") === true).length;
  if (relicCount + arcanes.length !== relicArcane.length) {
    throw new Error("ExportRelicArcane contains records outside the verified relic/arcane path classes");
  }
  appendArrayProjection(output, sourceByPath, "catalog/upgrades/arcanes.json",
    enrich(arcanes).map((record) => normalizeRanks(record, false)), [INPUTS.relicArcane]);

  const recipeInput = requiredArray(exports.recipes, "ExportRecipes");
  const recipes: Record<string, JsonValue> = {};
  for (const value of recipeInput) {
    const recipe = identified(value, "recipe");
    const key = recipe.recordKey as string;
    recipe.recipeKind = "ordinary";
    recipe.quantityBasis = "per_build";
    validateNonNegativeFields(recipe, ["buildPrice", "buildTime", "skipBuildTimePrice", "num"]);
    if (recipes[key] !== undefined) throw new Error(`Duplicate recipe identity: ${key}`);
    // 成品与材料都按 uniqueName 内嵌双语名称和图标，保留原始引用字段。
    const resultType = recipe.resultType;
    if (typeof resultType === "string") {
      recipe.resultItem = itemReference(resultType, enRecords, zhRecords, iconUrls);
      const zhProduct = zhRecords.get(resultType);
      if (zhProduct && typeof zhProduct.name === "string") recipe.resultTypeNameZh = zhProduct.name;
    }
    const rawIngredients = value.ingredients ?? [];
    if (!Array.isArray(rawIngredients)) throw new Error(`${key}: ingredients must be an array`);
    recipe.ingredients = rawIngredients.map((raw, index) => {
      const ingredient = object(raw, `${key}: ingredient ${index}`);
      const itemType = text(ingredient, "ItemType");
      if (!itemType?.startsWith("/")) {
        throw new Error(`${key}: ingredient ${index} lacks full item identity`);
      }
      validateNonNegativeFields(ingredient, ["ItemCount"]);
      if (ingredient.ItemCount === undefined || ingredient.ItemCount === null) {
        throw new Error(`${key}: ingredient ${index} lacks ItemCount`);
      }
      const materialNameZh = typeof itemType === "string" ? zhRecords.get(itemType)?.name : undefined;
      return {
        ...ingredient,
        ingredientOrder: index,
        item: itemReference(itemType, enRecords, zhRecords, iconUrls),
        ...(typeof materialNameZh === "string" ? { itemTypeNameZh: materialNameZh } : {}),
      };
    });
    recipes[key] = toJsonValue(recipe);
  }
  appendProjection(output, sourceByPath, "catalog/craft/recipes.json", recipes, [INPUTS.recipes], recipeInput.length);

  appendTranslations(output, sourceByPath, iconUrls);

  return output;
}

/** 官方 ExportUpgrades 文件内部嵌套的 3 个可翻译数组。 */
const UPGRADE_EXPORT_KEYS = ["ExportUpgrades", "ExportFocusUpgrades", "ExportAvionics"] as const;
const LOCALIZED_EXPORT_NAMES = ["Warframes", "Weapons", "Upgrades", "RelicArcane", "Regions", "Resources", "Recipes"] as const;

/** 读取官方 ExportManifest（shared），构建 uniqueName → 图标 URL 与「战甲名 → 头像 URL」。 */
function readIconUrls(sourceByPath: Map<string, DatasetFileInput>): { iconUrls: Map<string, string>; avatarUrls: Map<string, string> } {
  const iconUrls = new Map<string, string>();
  const avatarUrls = new Map<string, string>();
  let root: JsonObject;
  try {
    root = readExport(sourceByPath, "public-export/shared/ExportManifest.json");
  } catch {
    return { iconUrls, avatarUrls };
  }
  const manifest = root.Manifest;
  if (!Array.isArray(manifest)) return { iconUrls, avatarUrls };
  for (const record of manifest) {
    if (typeof record !== "object" || record === null) continue;
    const { uniqueName, textureLocation } = record as JsonObject;
    if (typeof uniqueName !== "string" || typeof textureLocation !== "string") continue;
    const url = `https://content.warframe.com/PublicExport/${textureLocation.replace(/^\//u, "")}`;
    iconUrls.set(uniqueName, url);
    // 头像：uniqueName 形如 …Image<Name>Bright（如 /Lotus/…/ImageYareliPrimeBright）→ Player 头像。
    if (uniqueName.includes("Image") && uniqueName.endsWith("Bright") && textureLocation.includes("/Player/")) {
      const frameName = uniqueName.split("/").pop()?.slice("Image".length, -"Bright".length);
      if (frameName) avatarUrls.set(frameName, url);
    }
  }
  return { iconUrls, avatarUrls };
}

/** 读取 zh 版本的官方 Export，构建 uniqueName → zh 完整记录（含 Resources 资源类）。 */
function readLocaleRecords(sourceByPath: Map<string, DatasetFileInput>, locale: string): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const exportName of LOCALIZED_EXPORT_NAMES) {
    const path = localizedPath(locale, exportName);
    if (!sourceByPath.has(path)) continue;
    const root = readExport(sourceByPath, path);
    for (const value of Object.values(root)) {
      if (!Array.isArray(value)) continue;
      for (const record of value) {
        if (typeof record !== "object" || record === null) continue;
        const uniqueName = (record as JsonObject).uniqueName;
        if (typeof uniqueName === "string" && !result.has(uniqueName)) result.set(uniqueName, record as JsonObject);
      }
    }
  }
  return result;
}

function readAbilityTranslations(
  sourceByPath: Map<string, DatasetFileInput>,
  locale: string,
): Map<string, { name?: string; description?: string }> {
  const path = localizedPath(locale, "Warframes");
  const root = readExport(sourceByPath, path);
  const values = root.ExportAbilities;
  if (values === undefined) return new Map();
  if (!Array.isArray(values)) throw new Error(`Expected ExportAbilities array in ${path}`);
  const translations = new Map<string, { name?: string; description?: string }>();
  for (const raw of values) {
    const record = object(raw, `${path}/ExportAbilities`);
    const uniqueName = text(record, "abilityUniqueName");
    if (!uniqueName) continue;
    if (translations.has(uniqueName)) throw new Error(`Duplicate standalone ability translation: ${uniqueName}/${locale}`);
    const name = text(record, "abilityName");
    const description = text(record, "description");
    translations.set(uniqueName, {
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  return translations;
}

function normalizeOwnerAbilities(records: JsonObject[], ownerType: string): JsonObject[] {
  return records.map((record) => {
    const owner = identified(record, ownerType);
    if (owner.abilities === undefined) return { ...owner, ownerType };
    if (!Array.isArray(owner.abilities)) throw new Error(`${owner.recordKey}: abilities must be an array`);
    return {
      ...owner,
      ownerType,
      abilities: owner.abilities.map((ability, index) => normalizeAbility(ability, `${owner.recordKey}: ability ${index}`)),
    };
  });
}

export function normalizeRanks(record: JsonObject, oneBased: boolean): JsonObject {
  const ranks = Array.isArray(record.levelStats) ? record.levelStats
    : Array.isArray(record.stats) ? record.stats : undefined;
  const ranksZh = Array.isArray(record.levelStatsZh) ? record.levelStatsZh
    : Array.isArray(record.statsZh) ? record.statsZh : undefined;
  if (!ranks && !ranksZh) return record;

  const length = Math.max(ranks?.length ?? 0, ranksZh?.length ?? 0);
  const normalized: JsonObject = { ...record, ranks: [] };
  const values: JsonObject[] = [];
  for (let index = 0; index < length; index += 1) {
    values.push({
      rank: index + (oneBased ? 1 : 0),
      ...(ranks?.[index] === undefined ? {} : { stats: ranks[index] }),
      ...(ranksZh?.[index] === undefined ? {} : { statsZh: ranksZh[index] }),
    });
  }
  normalized.ranks = values;
  delete normalized.levelStats;
  delete normalized.levelStatsZh;
  delete normalized.statsZh;
  if (Array.isArray(normalized.stats)) delete normalized.stats;
  return normalized;
}

function itemReference(
  uniqueName: string,
  enRecords: Map<string, JsonObject>,
  zhRecords: Map<string, JsonObject>,
  iconUrls: Map<string, string>,
): JsonObject {
  const key = canonicalUniqueName(uniqueName);
  const english = enRecords.get(uniqueName) ?? enRecords.get(key);
  const chinese = zhRecords.get(uniqueName) ?? zhRecords.get(key);
  const iconUrl = iconUrls.get(uniqueName) ?? iconUrls.get(key);
  return {
    uniqueName,
    name: text(english ?? {}, "name") ?? "",
    nameZh: text(chinese ?? {}, "name") ?? "",
    ...(iconUrl ? { iconUrl } : {}),
  };
}

function canonicalUniqueName(uniqueName: string): string {
  return uniqueName.replace("/Lotus/StoreItems/", "/Lotus/");
}

/** 给实体记录按 uniqueName 对齐内联中文字段 + 图标/头像（追加 *Zh，不删除原字段）。 */
function enrichRecords(
  records: JsonObject[],
  zhRecords: Map<string, JsonObject>,
  iconUrls: Map<string, string>,
  avatarUrls: Map<string, string>,
): JsonObject[] {
  return records.map((record) => {
    const key = record.recordKey ?? record.uniqueName;
    const keyStr = typeof key === "string" ? key : undefined;
    const next: JsonObject = { ...record };
    const iconUrl = keyStr ? iconUrls.get(keyStr) : undefined;
    if (iconUrl) next.iconUrl = iconUrl;
    // avatarUrl：战甲英文名（去空格）→ Player 头像。
    if (typeof next.name === "string") {
      const avatarUrl = avatarUrls.get(next.name.replace(/\s+/gu, ""));
      if (avatarUrl) next.avatarUrl = avatarUrl;
    }
    const zh = keyStr ? zhRecords.get(keyStr) : undefined;
    if (!zh) return next;
    if (typeof zh.name === "string") next.nameZh = zh.name;
    const zhDescription = zh.description;
    if (typeof zhDescription === "string" || Array.isArray(zhDescription)) next.descriptionZh = zhDescription;
    if (typeof zh.passiveDescription === "string") next.passiveDescriptionZh = zh.passiveDescription;
    if (typeof zh.compatName === "string") next.compatNameZh = zh.compatName;
    if (Array.isArray(zh.stats)) next.statsZh = zh.stats;
    if (Array.isArray(zh.levelStats)) next.levelStatsZh = zh.levelStats;
    // abilities：追加 abilityNameZh / descriptionZh / abilityIconUrl（技能图标）。
    const zhAbilities = Array.isArray(zh.abilities) ? zh.abilities : undefined;
    if (Array.isArray(next.abilities) && zhAbilities) {
      next.abilities = next.abilities.map((rawAbility, index) => {
        const ability = object(rawAbility, `ability ${index}`);
        const localized: JsonObject = { ...ability };
        const zhAbility = zhAbilities[index];
        if (zhAbility && typeof zhAbility === "object" && zhAbility !== null) {
          const z = zhAbility as JsonObject;
          if (typeof z.abilityName === "string") localized.abilityNameZh = z.abilityName;
          if (typeof z.description === "string") localized.descriptionZh = z.description;
        }
        const abilityKey = ability.abilityUniqueName;
        if (typeof abilityKey === "string") {
          const abilityIcon = iconUrls.get(abilityKey);
          if (abilityIcon) localized.abilityIconUrl = abilityIcon;
        }
        return localized;
      });
    }
    return next;
  });
}

function appendTranslations(
  output: DatasetFileInput[],
  sourceByPath: Map<string, DatasetFileInput>,
  iconUrls: Map<string, string>,
): void {
  const items: Record<string, JsonValue> = {};
  const recipesByLocale: Record<string, JsonObject[]> = {};
  const inputPaths: string[] = [];

  for (const locale of LOCALES) {
    const localized = readLocalizedExports(sourceByPath, locale);
    inputPaths.push(...localized.paths);
    recipesByLocale[locale] = [];

    for (const [sourceType, records] of Object.entries(localized.records)) {
      if (sourceType === "nodes") continue;
      if (sourceType === "recipes") {
        recipesByLocale[locale] = records;
        continue;
      }
      for (const record of records) {
        const uniqueName = text(record, "uniqueName");
        if (!uniqueName?.startsWith("/")) continue;
        const lang = localizedObject(items, uniqueName, locale);
        mergeField(lang, "name", record.name, `${uniqueName}/${locale}`);
        mergeField(lang, "description", record.description, `${uniqueName}/${locale}`);
        if (Array.isArray(record.abilities)) {
          const translatedAbilities = Array.isArray(lang.abilities) ? lang.abilities as JsonValue[] : [];
          for (const rawAbility of record.abilities) {
            const ability = object(rawAbility, `${uniqueName}: ability translation`);
            const abilityUniqueName = text(ability, "abilityUniqueName");
            if (!abilityUniqueName?.startsWith("/")) throw new Error(`${uniqueName}: ability translation lacks identity`);
            const translated = {
              abilityUniqueName,
              abilityName: ability.abilityName,
              description: ability.description,
            };
            const previous = translatedAbilities.find((value) =>
              object(value, "translated ability").abilityUniqueName === abilityUniqueName,
            );
            if (previous && !sameJson(object(previous, "translated ability"), translated)) {
              throw new Error(`Conflicting ability translation: ${abilityUniqueName}/${locale}`);
            }
            if (!previous) translatedAbilities.push(toJsonValue(translated));
          }
          if (translatedAbilities.length > 0) lang.abilities = translatedAbilities;
        }
      }
    }
  }

  for (const uniqueName of Object.keys(items)) {
    const entry = items[uniqueName];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const iconUrl = iconUrls.get(uniqueName) ?? iconUrls.get(canonicalUniqueName(uniqueName));
    if (iconUrl) (entry as Record<string, JsonValue>).iconUrl = iconUrl;
  }

  // recipe 本身没有 name 字段；从 resultType 指向的产物名推导 en/zh 蓝图名。
  for (const locale of ["en", "zh"] as const) {
    const suffix = locale === "en" ? " Blueprint" : "蓝图";
    for (const recipe of recipesByLocale[locale] ?? []) {
      const uniqueName = text(recipe, "uniqueName");
      const resultType = text(recipe, "resultType");
      if (!uniqueName?.startsWith("/") || !resultType) continue;
      const productName = localizedName(items, resultType, locale);
      if (productName === undefined) continue;
      const lang = localizedObject(items, uniqueName, locale);
      mergeField(lang, "name", `${productName}${suffix}`, `${uniqueName}/${locale}`);
    }
  }

  appendProjection(output, sourceByPath, "catalog/i18n/items.json", items, inputPaths, Object.keys(items).length);
}

/** 读取某个语言版本的 6 个官方 Export 文件，并按翻译字段归类。 */
function readLocalizedExports(
  sourceByPath: Map<string, DatasetFileInput>,
  locale: string,
): { paths: string[]; records: Record<string, JsonObject[]> } {
  const warframesRoot = readExport(sourceByPath, localizedPath(locale, "Warframes"));
  const weaponsRoot = readExport(sourceByPath, localizedPath(locale, "Weapons"));
  const upgradesRoot = readExport(sourceByPath, localizedPath(locale, "Upgrades"));
  const relicArcaneRoot = readExport(sourceByPath, localizedPath(locale, "RelicArcane"));
  const regionsRoot = readExport(sourceByPath, localizedPath(locale, "Regions"));
  const recipesRoot = readExport(sourceByPath, localizedPath(locale, "Recipes"));
  const resourcesPath = localizedPath(locale, "Resources");
  const resourcesRoot = sourceByPath.has(resourcesPath) ? readExport(sourceByPath, resourcesPath) : {};

  return {
    paths: [
      localizedPath(locale, "Warframes"),
      localizedPath(locale, "Weapons"),
      localizedPath(locale, "Upgrades"),
      localizedPath(locale, "RelicArcane"),
      localizedPath(locale, "Regions"),
      localizedPath(locale, "Recipes"),
      ...(sourceByPath.has(resourcesPath) ? [resourcesPath] : []),
    ],
    records: {
      warframes: requiredArray(warframesRoot, "ExportWarframes"),
      weapons: requiredArray(weaponsRoot, "ExportWeapons"),
      railjackWeapons: weaponsRoot.ExportRailjackWeapons === undefined
        ? [] : requiredArray(weaponsRoot, "ExportRailjackWeapons"),
      upgrades: UPGRADE_EXPORT_KEYS.flatMap((key) =>
        upgradesRoot[key] === undefined ? [] : requiredArray(upgradesRoot, key)),
      modSets: upgradesRoot.ExportModSet === undefined
        ? [] : requiredArray(upgradesRoot, "ExportModSet"),
      relicArcane: requiredArray(relicArcaneRoot, "ExportRelicArcane"),
      recipes: requiredArray(recipesRoot, "ExportRecipes"),
      nodes: requiredArray(regionsRoot, "ExportRegions"),
      resources: resourcesRoot.ExportResources === undefined ? [] : requiredArray(resourcesRoot, "ExportResources"),
    },
  };
}

function localizedName(
  items: Record<string, JsonValue>,
  uniqueName: string,
  locale: string,
): string | undefined {
  const item = items[uniqueName];
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const lang = (item as Record<string, JsonValue>)[locale];
  if (typeof lang !== "object" || lang === null || Array.isArray(lang)) return undefined;
  const name = (lang as Record<string, JsonValue>).name;
  return typeof name === "string" ? name : undefined;
}

function localizedObject(
  root: Record<string, JsonValue>,
  uniqueName: string,
  locale: string,
): Record<string, JsonValue> {
  const current = root[uniqueName];
  const item = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, JsonValue> : {};
  const currentLocale = item[locale];
  const localized = currentLocale && typeof currentLocale === "object" && !Array.isArray(currentLocale)
    ? currentLocale as Record<string, JsonValue> : {};
  item[locale] = localized;
  root[uniqueName] = item;
  return localized;
}

function mergeField(target: Record<string, JsonValue>, field: string, value: unknown, owner: string): void {
  if (value === undefined || value === null) return;
  const normalized = toJsonValue(value);
  if (target[field] !== undefined && !sameJson(target[field], normalized)) {
    throw new Error(`Conflicting Public Export translation: ${owner}/${field}`);
  }
  target[field] = normalized;
}

function appendArrayProjection(
  output: DatasetFileInput[],
  sourceByPath: Map<string, DatasetFileInput>,
  path: string,
  records: JsonObject[],
  inputs: string[],
): void {
  appendProjection(output, sourceByPath, path, records, inputs, records.length);
}

function appendProjection(
  output: DatasetFileInput[],
  sourceByPath: Map<string, DatasetFileInput>,
  path: string,
  value: JsonValue | JsonObject[],
  inputPaths: string[],
  recordCount: number,
): void {
  const inputSources = inputPaths.map((inputPath) => {
    const input = sourceByPath.get(inputPath);
    if (!input) throw new Error(`Projection input is missing: ${inputPath}`);
    return input;
  });
  const primary = inputSources[0]?.source;
  if (!primary) throw new Error(`Projection ${path} has no source metadata`);
  output.push({
    stage: "cleaned",
    path,
    content: `${JSON.stringify(value, null, 2)}\n`,
    recordCount,
    source: {
      ...primary,
      dataset: path,
      upstreamRevision: createHash("sha256").update(inputSources
        .map((source) => `${source.path}:${source.source.upstreamRevision ?? ""}`).join("\n")).digest("hex"),
      transformer: "warframe-datasource-nnm/public-export-projection@1",
      derivedFrom: inputPaths,
    },
  });
}

function readExport(sourceByPath: Map<string, DatasetFileInput>, path: string): JsonObject {
  const source = sourceByPath.get(path);
  if (!source) throw new Error(`Projection input is missing: ${path}`);
  try {
    return object(JSON.parse(Buffer.isBuffer(source.content) ? source.content.toString("utf8") : source.content) as unknown, path);
  } catch (error) {
    throw new Error(`Projection input is invalid JSON: ${path}`, { cause: error });
  }
}

function requiredArray(root: JsonObject, key: string): JsonObject[] {
  const value = root[key];
  if (!Array.isArray(value)) throw new Error(`Expected ${key} to be an array`);
  return value.map((record, index) => object(record, `${key}[${index}]`));
}

function normalizeAbility(value: unknown, context: string): JsonObject {
  const ability = object(value, context);
  const uniqueName = text(ability, "abilityUniqueName");
  if (!uniqueName?.startsWith("/")) throw new Error(`${context} lacks full ability identity`);
  return identified({ ...ability, uniqueName, name: ability.abilityName }, context);
}

function identified(value: JsonObject, context: string): JsonObject {
  const uniqueName = text(value, "uniqueName");
  if (!uniqueName || uniqueName.trim() !== uniqueName) throw new Error(`${context} record lacks uniqueName`);
  if (value.recordKey !== undefined && value.recordKey !== uniqueName) {
    throw new Error(`${context} recordKey conflicts with uniqueName: ${uniqueName}`);
  }
  return { ...value, recordKey: uniqueName };
}

function addUnique(target: Map<string, JsonObject>, key: string, value: JsonObject, label: string): void {
  const previous = target.get(key);
  if (previous && !sameJson(previous, value)) throw new Error(`Conflicting same-build ${label}: ${key}`);
  target.set(key, previous ?? value);
}

function validateNonNegativeFields(value: JsonObject, fields: string[]): void {
  for (const field of fields) {
    const entry = value[field];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      throw new Error(`${field} must be a nonnegative safe integer`);
    }
  }
}

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
  return value as JsonObject;
}

function text(value: JsonObject, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) result[key] = toJsonValue(child);
    return result;
  }
  throw new Error("Projection contains a non-JSON value");
}
