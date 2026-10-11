#!/usr/bin/env node
import { SubzeroSupportSync } from "./packages/rdk-node/dist/support-sync.js";
const worker = await SubzeroSupportSync.create(
  process.env.SUBZERO_API_URL ?? "",
  process.env.SUBZERO_AGENT_TOKEN ?? "",
  Number(process.env.SUBZERO_PROJECT_ID),
);
// Deliberately serial: only one publication loop per node/process.
for (;;) {
  try {
    await worker.tick();
  } catch (e) {
    console.error("Support publication paused:", e.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
}
