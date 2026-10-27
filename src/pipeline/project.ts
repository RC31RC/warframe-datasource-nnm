import type { DatasetFileInput } from "../domain/contracts.js";
import { projectDropTableHtml } from "../collectors/droptables.js";
import { projectPublicExport } from "../projections/public-export.js";
import { projectRiven } from "../projections/riven.js";
import { enrichRivenAttributes } from "../projections/riven-attributes.js";
import { projectMarketItems } from "../projections/linked.js";
import { projectRelics } from "../projections/relics.js";
import { projectDropTables } from "../projections/drops.js";
import { enrichPlusReferences } from "../projections/plus.js";
import { projectRivenWeapons } from "../projections/riven-weapons.js";
import { projectWorldstateCodebook } from "../projections/worldstate.js";
import { enrichNameZh } from "../projections/enrich.js";
import { supplementCatalogs } from "../projections/supplements.js";
import { projectActivityDefinitions } from "../projections/activities.js";
import { enrichBusinessDepth } from "../projections/business-depth.js";
import { enrichOfficialMedia } from "../projections/media.js";
import { finishProducts } from "../projections/finish.js";
import { consolidateBounties } from "../projections/bounties.js";
import { supplementCreditBundles } from "../projections/credit-bundles.js";
import { organizeEntityOwnership } from "../projections/entity-ownership.js";
import { compactProducts } from "../projections/compact.js";
import { finalizeBilingualProducts } from "../projections/bilingual.js";

/** Pure projection over one frozen acquisition; no clock or network access. */
export function projectInputs(inputs: DatasetFileInput[]): DatasetFileInput[] {
  const select = (prefix: string) => inputs.filter((file) => file.path.startsWith(prefix));
  const publicExport = select("public-export/");
  const languages = select("languages/");
  const plus = supplementCreditBundles(select("plus/"), languages);
  const rawDrops = inputs.find((file) => file.stage === "raw" && file.path === "droptables/droptables.html");
  if (!rawDrops) throw new Error("Missing official drop HTML");
  const drops = enrichNameZh(projectDropTableHtml(rawDrops), languages);
  const catalog = enrichOfficialMedia(supplementCatalogs(projectPublicExport(publicExport), publicExport, plus, languages), inputs);
  const world = enrichNameZh(projectWorldstateCodebook(publicExport, plus, languages), languages);
  const market = projectMarketItems(catalog, inputs.filter((file) => file.path === "market/items.json" || file.path === "warframe-market/items-v2.json"));
  const riven = projectRiven(publicExport, languages);
  const attributes = enrichRivenAttributes(inputs.filter((file) => file.path === "market/riven-attributes.json"), riven);
  const weapons = projectRivenWeapons([...inputs, ...riven]);
  const relics = enrichNameZh(projectRelics(publicExport, catalog, drops, market, languages, plus), languages);
  const cleaned = [
    ...catalog.filter((file) => file.path !== "catalog/loot/relics.json"),
    ...market.filter((file) => file.stage === "cleaned"),
    ...riven.filter((file) => file.path === "riven/definitions.json"), ...attributes, ...weapons,
    ...projectDropTables(drops, [...catalog, ...world, ...enrichNameZh(plus, languages)], languages),
    ...enrichNameZh(plus, languages),
    ...languages, ...select("usage/").filter((file) => file.stage === "cleaned"),
    ...relics, ...world, ...projectActivityDefinitions(languages),
  ].filter((file) => file.stage === "cleaned");
  return [...inputs.filter((file) => file.stage === "raw"), ...finalizeBilingualProducts(compactProducts(organizeEntityOwnership(finishProducts(enrichPlusReferences(consolidateBounties(enrichBusinessDepth(cleaned)), cleaned), publicExport))))];
}
