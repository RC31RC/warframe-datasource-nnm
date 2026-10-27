import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const workflow = readFileSync(new URL("../.github/workflows/collect.yml", import.meta.url), "utf8");
test("publishing has scheduled/manual/source-push triggers, but no broad data push trigger", () => {
  assert.match(workflow, /schedule:\s*\n[\s\S]*cron: "17 3 \* \* \*"/u);
  assert.match(workflow, /workflow_dispatch: \{\}/u);
  assert.match(workflow, /push:\s*\n\s+branches: \[main\]/u);
  const paths = workflow.slice(workflow.indexOf("    paths:"), workflow.indexOf("  workflow_dispatch:"));
  assert.match(paths, /"src\/\*\*"/u); assert.doesNotMatch(paths, /data|tmp/u);
});
test("publishing keeps diagnostics, stages only products/cache and handles existing tags", () => {
  assert.match(workflow, /fetch-depth: 0/u); assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /set -o pipefail/u); assert.match(workflow, /tee "\$RUNNER_TEMP\/warframe-collect.log"/u);
  assert.match(workflow, /uses: actions\/upload-artifact@v4/u); assert.match(workflow, /GITHUB_STEP_SUMMARY/u);
  assert.match(workflow, /git add -- data\/latest tmp\/cache/u); assert.doesNotMatch(workflow, /git add data tmp pluto/u);
  assert.match(workflow, /git push --atomic origin "HEAD:\$TARGET_BRANCH"/u);
});
