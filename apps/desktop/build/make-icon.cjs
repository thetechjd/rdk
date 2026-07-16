// Rasterize the RetroDeck cartridge SVG into app-icon PNGs via Chromium (full SVG
// support). Run with: electron build/make-icon.cjs
// Produces build/icon.png (1024²) centered on a transparent square canvas.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
const SIZE = 1024;
const svg = fs.readFileSync(path.join(__dirname, 'icon-source.svg'), 'utf-8');

// Center the (portrait) cartridge with padding on a transparent square.
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden;}
  .wrap{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;justify-content:center;}
  .wrap svg{height:${Math.round(SIZE * 0.76)}px;width:auto;display:block;}
</style></head><body><div class="wrap">${svg}</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE, height: SIZE, show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', useContentSize: true,
    webPreferences: { offscreen: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.setZoomFactor(1);
  await new Promise(r => setTimeout(r, 400));
  let img = await win.webContents.capturePage();
  const sz = img.getSize();
  if (sz.width !== SIZE || sz.height !== SIZE) img = img.resize({ width: SIZE, height: SIZE });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.toPNG());
  console.log('ICON_OK captured', sz, '→ icon.png', img.getSize());
  app.exit(0);
});
