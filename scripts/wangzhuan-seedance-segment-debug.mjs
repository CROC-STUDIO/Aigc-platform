#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import {
  parseDebugCliArgs,
  runSeedanceSegmentDebugCli
} from "../server/wangzhuan/seedance-segment-debug.mjs";

export async function main() {
  const options = parseDebugCliArgs(process.argv.slice(2));
  const result = await runSeedanceSegmentDebugCli(options);
  console.log("Seedance segment debug files written:");
  console.log(`analysis: ${result.paths.analysisPath}`);
  console.log(`plan: ${result.paths.planPath}`);
  console.log(`prompts: ${result.paths.promptsPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
