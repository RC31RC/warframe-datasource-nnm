/** 正式成品的十一个业务目录；内部投影路径与发布路径在此统一对齐。 */
export const PRODUCT_DIRECTORIES = [
  "equipment", "upgrades", "items", "crafting", "world", "rewards",
  "progression", "worldstate", "market", "reference", "statistics",
] as const;

/** 历史成品路径到当前发布路径的映射；不复制旧路径作为兼容成品。 */
export const PRODUCT_PATH_ALIASES: Readonly<Record<string, string>> = {
  "catalog/craft/recipes.json": "crafting/recipes.json",
  "catalog/i18n/items.json": "reference/item-localizations.json",
  "localization/items.json": "reference/item-localizations.json",
  "catalog/loot/relics.json": "rewards/relics.json",
  "relics/catalog.json": "rewards/relics.json",
  "catalog/world/map.json": "world/star-chart.json",
  "star-chart/map.json": "world/star-chart.json",
  "star-chart/tilesets.json": "world/tilesets.json",
  "market/riven-attributes.json": "upgrades/riven-attributes.json",
  "riven/attributes.json": "upgrades/riven-attributes.json",
  "riven/definitions.json": "upgrades/riven-definitions.json",
  "riven/weapons.json": "upgrades/riven-weapons.json",
  "companions/animals.json": "equipment/companions-animals.json",
  "companions/sentinels.json": "equipment/companions-sentinels.json",
  "resources/items.json": "items/resources.json",
  "cosmetics/catalog.json": "items/skins.json",
  "cosmetics/flavour.json": "items/customizations.json",
  "commerce/booster-packs.json": "items/reward-packs.json",
  "commerce/boosters.json": "items/boosters.json",
  "commerce/bundles.json": "items/bundles.json",
  "commerce/credit-bundles.json": "items/credit-bundles.json",
  "commerce/fusion-bundles.json": "items/endo-bundles.json",
  "commerce/vendors.json": "world/vendors.json",
  "virtual-items/catalog.json": "items/internal-definitions.json",
  "codex/entries.json": "world/codex.json",
  "enemies/catalog.json": "world/enemies.json",
  "quests/keys.json": "world/quest-keys.json",
  "communications/email-items.json": "world/inbox-messages.json",
  "drop/tables.json": "rewards/drop-tables.json",
  "rewards/catalog.json": "rewards/reward-pools.json",
  "bounties/catalog.json": "rewards/bounties.json",
  "market/items.json": "market/trade-items.json",
  "languages/en.json": "reference/language-en.json",
  "languages/zh.json": "reference/language-zh.json",
  "assets/images.json": "reference/images.json",
  "assets/text-icons.json": "reference/text-icons.json",
  "plus/activityresources.json": "world/activity-resources.json",
  "plus/achievements.json": "progression/achievements.json",
  "plus/animals.json": "equipment/companions-animals.json",
  "plus/boosterpacks.json": "items/reward-packs.json",
  "plus/boosters.json": "items/boosters.json",
  "plus/bounties.json": "rewards/bounties.json",
  "plus/bundles.json": "items/bundles.json",
  "plus/challenges.json": "progression/challenges.json",
  "plus/codex.json": "world/codex.json",
  "plus/creditbundles.json": "items/credit-bundles.json",
  "plus/emailitems.json": "world/inbox-messages.json",
  "plus/enemies.json": "world/enemies.json",
  "plus/images.json": "reference/images.json",
  "plus/intrinsics.json": "progression/intrinsics.json",
  "plus/nightwave.json": "progression/nightwave.json",
  "plus/rewards.json": "rewards/reward-pools.json",
  "plus/texticons.json": "reference/text-icons.json",
  "plus/tilesets.json": "world/tilesets.json",
  "plus/vendors.json": "world/vendors.json",
  "plus/virtuals.json": "items/internal-definitions.json",
};

/** 只转换成品位置，不改游戏 ID、协议键、源输入路径或实体字段。 */
export function canonicalProductPath(path: string): string {
  const alias = PRODUCT_PATH_ALIASES[path];
  if (alias) return alias;
  const catalog = /^catalog\/(equipment|upgrades)\/(.+)\.json$/u.exec(path);
  if (catalog) return `${catalog[1]}/${catalog[2]}.json`;
  const usage = /^usage\/(\d{4})\.json$/u.exec(path);
  if (usage) return `statistics/usage-${usage[1]}.json`;
  return path;
}
