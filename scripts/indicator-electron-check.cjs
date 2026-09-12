// Run with Electron and INDICATOR_MODULE pointing to an installed indicator.cjs.
// This starts a hidden, isolated fixture app, never the user's Discord profile.
if (process.type === "renderer") {
  require(process.env.INDICATOR_MODULE);
} else {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "soundshare-electron-check-"));
  app.setPath("userData", profile);
  app.disableHardwareAcceleration();
  const timer = setTimeout(() => { console.error("Indicator integration timed out"); app.exit(1); }, 15000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: __filename, sandbox: false, contextIsolation: true, nodeIntegration: false,
    } });
    win.webContents.on("preload-error", (_event, _path, error) => console.error(error));
    await win.loadURL('data:text/html,<button aria-label="Stop Streaming" style="width:80px;height:40px">Share</button>');
    const result = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      let attempts = 0;
      const timer = setInterval(() => {
        const dot = document.querySelector('[data-soundshare-fix]');
        if (dot) { clearInterval(timer); resolve({ state: dot.dataset.state, text: document.querySelector('[role="tooltip"]').textContent, nodeExposed: typeof require !== 'undefined' }); }
        else if (++attempts > 40) { clearInterval(timer); reject(new Error('No indicator')); }
      }, 100);
    })`);
    console.log(JSON.stringify(result));
    clearTimeout(timer);
    app.exit(result.state === "waiting" && !result.nodeExposed ? 0 : 1);
  }).catch((error) => { console.error(error); app.exit(1); });
}
