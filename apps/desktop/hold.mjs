import { _electron as electron } from 'playwright';
const SHOT = '/tmp/claude-1000/-run-media-kevanj11-linux-drive1-RetrodeckLandingPage/12645f45-49d0-4f8d-92c7-8672833bbc9b/scratchpad';
const app = await electron.launch({ args: ['.'], cwd: process.cwd() });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

for (const t of [10, 30, 60, 90]) {
  await win.waitForTimeout(t === 10 ? 10000 : 20000);
  const status = await win.evaluate(() => window.rdk.getStatus());
  console.log(`t=${t}s ui: wsConnected=${status.wsConnected} contentServing=${status.contentServing} serving=${status.serving ?? '-'}`);
}
await win.screenshot({ path: `${SHOT}/status.png` });
await app.close();
