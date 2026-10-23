import { resolve } from "node:path";
import { config } from "./core/config.js";
import { DatasetPublisher } from "./publish/dataset-publisher.js";
import { acquire, loadInputs } from "./pipeline/acquire.js";
import { projectInputs } from "./pipeline/project.js";

const command = process.argv[2] ?? "help";
try {
  const publisher = new DatasetPublisher(config.dataDirectory, config.tmpDirectory);
  if (command === "collect" || command === "replay") {
    const directory = resolve(process.argv[3] ?? `${config.tmpDirectory}/inputs-${new Date().toISOString().replaceAll(":", "-")}`);
    const inputs = command === "collect" ? await acquire(directory) : await loadInputs(directory);
    const files = projectInputs(inputs);
    const result = await publisher.publish(files);
    console.log(`Generated ${result.manifest.buildId} (${result.manifest.files.length} files)`);
    console.log(`Frozen inputs: ${directory}`);
  } else if (command === "verify") {
    const result = await publisher.verify();
    console.log(`Verified ${result.verifiedFiles} files in ${result.buildId}`);

  } else if (["help", "--help", "-h"].includes(command)) {
    console.log("Usage: collect [snapshot-dir] | replay <snapshot-dir> | verify");
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
