// Optional browser check: PLAYWRIGHT_PATH may point to a bundled Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
  try {
    const page = await browser.newPage({ viewport: { width: 440, height: 190 }, deviceScaleFactor: 2 });
    await page.setContent(`<style>
      body{margin:0;background:#25272e;color:#e4e6ec;font:14px system-ui}
      main{padding:20px;display:flex;gap:10px;align-items:center}
      button{height:40px;width:48px;border:0;border-radius:10px;background:#15161a;color:#d7dbe2;display:grid;place-items:center}
      #share{background:#173f2b;color:#87d8a4} #end{background:#d42940;color:white}
      svg{width:22px;height:22px}
    </style><main><button aria-label="Mute">♩</button><button aria-label="Camera">▰</button>
      <button id="share" aria-label="Stop Streaming" aria-describedby="existing"><svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 21h8M12 17v4M9 8l6 5m0-5-6 5" stroke="currentColor" stroke-width="2"/></svg></button>
      <button aria-label="Activities">✣</button><button aria-label="More">···</button><button id="end" aria-label="Disconnect">☎</button>
      </main><span id="existing" hidden>Original description</span>`);
    const source = await fs.readFile(path.join(__dirname, "../runtime/indicator.cjs"), "utf8");
    await page.addScriptTag({ content: `globalThis.__soundshareFixIndicator = true;
      (() => { const module = { exports: {} }; ${source}
      window.statusFixture = { state: 1, hits: 18, blocked: 12 };
      window.indicatorTest = module.exports.mountIndicator({document, window, readStatus: () => window.statusFixture}); })();` });
    assert.equal(await page.locator('[data-soundshare-fix="indicator"]').count(), 1);
    assert.equal(await page.locator('[data-soundshare-fix]').getAttribute("data-state"), "active");
    const box = await page.locator("#share").boundingBox();
    await page.evaluate(() => { window.clicks = 0; document.querySelector("#share").addEventListener("click", () => window.clicks++); });
    await page.mouse.move(box.x + box.width - 5, box.y + 7);
    assert.equal(await page.locator('[role="tooltip"]').evaluate((el) => getComputedStyle(el).visibility), "visible");
    assert.match(await page.locator('[role="tooltip"]').textContent(), /blocked restarts: 12/);
    await page.screenshot({ path: process.env.INDICATOR_SCREENSHOT || "/tmp/soundshare-indicator-preview.png" });
    await page.mouse.click(box.x + box.width - 5, box.y + 7);
    assert.equal(await page.evaluate(() => window.clicks), 1, "dot must not intercept stop-streaming click");
    for (const [state, expected] of [[-1, "error"], [0, "waiting"], [-2, "unknown"], [4, "error"]]) {
      await page.evaluate((state) => { window.statusFixture = { state }; window.indicatorTest.refresh(); }, state);
      assert.equal(await page.locator('[data-soundshare-fix]').getAttribute("data-state"), expected);
    }
    await page.evaluate(() => { document.querySelector("#share").setAttribute("aria-label", "Camera"); window.indicatorTest.refresh(); });
    assert.equal(await page.locator('[data-soundshare-fix]').count(), 0);
    assert.equal(await page.locator("#share").getAttribute("aria-describedby"), "existing");
    await page.evaluate(() => { document.querySelector("#share").setAttribute("aria-label", "Stop Streaming"); window.indicatorTest.refresh(); window.indicatorTest.refresh(); });
    assert.equal(await page.locator('[data-soundshare-fix]').count(), 1);
    await page.locator("#share").evaluate((button) => button.blur());
    await page.locator("#share").focus();
    assert.equal(await page.locator('[role="tooltip"]').evaluate((el) => getComputedStyle(el).visibility), "visible");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[role="tooltip"]').evaluate((el) => getComputedStyle(el).visibility), "hidden");
    await page.evaluate(() => { document.querySelector("#share").style.display = "none"; window.indicatorTest.refresh(); });
    assert.equal(await page.locator('[data-soundshare-fix]').evaluate((el) => getComputedStyle(el).display), "none");
    await page.evaluate(() => window.indicatorTest.stop());
    assert.equal(await page.locator('[data-soundshare-fix]').count(), 0);
    assert.equal(await page.locator('[role="tooltip"]').count(), 0);
    assert.equal(await page.locator("#share").getAttribute("aria-describedby"), "existing");
    console.log("Browser checks passed: placement, tooltip, original click, state changes, keyboard, cleanup and rerender.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
