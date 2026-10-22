import { collectPublicExport } from "./collectors/public-export.js";
import { collectMarketItems, collectRivenAttributes, collectRivenWeapons } from "./collectors/market.js";
import { collectWeeklyRivens } from "./collectors/riven.js";
import { collectPlusExports } from "./collectors/plus.js";
import { collectDropTables } from "./collectors/droptables.js";
import { collectUsageData } from "./collectors/usage.js";
import { collectLanguagesBinData } from "./collectors/languages.js";
import { collectArbitrationSchedule } from "./collectors/arbitration.js";
import { config } from "./core/config.js";
import { DatasetPublisher } from "./publish/dataset-publisher.js";
import { projectPublicExport } from "./projections/public-export.js";
import { projectRiven } from "./projections/riven.js";
import { projectLinkedItems, projectLinkedRelics } from "./projections/linked.js";
import { projectWorldstateCodebook } from "./projections/worldstate.js";
import { projectArbitrationSchedule } from "./projections/arbitration.js";
import { enrichNameZh } from "./projections/enrich.js";

const command = process.argv[2] ?? "help";

try {
  if (command === "collect") {
    const publicExportFiles = await collectPublicExport();
    const catalogFiles = projectPublicExport(publicExportFiles);
    const marketItemFiles = await collectMarketItems();
    const dropTableFiles = await collectDropTables();
    const plusFiles = await collectPlusExports();
    const languagesFiles = await collectLanguagesBinData();
    // catalog 的中文已由 projectPublicExport 按 zh Export 对齐内联，此处无需再走 languages 反查。
    const enrichedDropFiles = enrichNameZh(dropTableFiles, languagesFiles);
    const enrichedPlusFiles = enrichNameZh(plusFiles, languagesFiles);
    // 解析层：先产出 worldstate 代码簿，再基于它解析仲裁排期（依赖节点代码簿）。
    const worldstateFiles = projectWorldstateCodebook(publicExportFiles, plusFiles, languagesFiles);
    const arbitrationRaw = await collectArbitrationSchedule();
    const files = [
      ...publicExportFiles,
      ...catalogFiles,
      ...projectRiven(publicExportFiles, languagesFiles),
      ...marketItemFiles,
      ...await collectRivenAttributes(),
      ...await collectRivenWeapons(),
      ...await collectWeeklyRivens(),
      ...enrichedDropFiles,
      ...enrichedPlusFiles,
      ...languagesFiles,
      ...await collectUsageData(),
      ...projectLinkedRelics(publicExportFiles, dropTableFiles, marketItemFiles),
      ...enrichNameZh(projectLinkedItems(catalogFiles, marketItemFiles), languagesFiles),
      ...worldstateFiles,
      arbitrationRaw,
      ...projectArbitrationSchedule(arbitrationRaw, worldstateFiles),
    ];
    const publisher = new DatasetPublisher(config.dataDirectory, config.tmpDirectory);
    const result = await publisher.publish(files);
    console.log(`Generated ${result.manifest.buildId} (${result.manifest.files.length} files) in ${result.dataDirectory}`);
    console.log(`Raw inputs in ${result.tmpDirectory}`);
  } else if (command === "verify") {
    const result = await new DatasetPublisher(config.dataDirectory, config.tmpDirectory).verify();
    console.log(`Verified ${result.verifiedFiles} files in ${result.buildId} (${result.directory})`);
  } else if (command === "help" || command === "--help" || command === "-h") {
    console.log("Usage: npm run collect | npm run verify");
  } else {
    throw new Error(`Unknown command: ${command}. Use npm run collect or npm run verify.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
}
