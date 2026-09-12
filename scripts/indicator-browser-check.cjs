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
    assert.equal(await page.locator('#share > [data-soundshare-fix]').count(), 1);
    const box = await page.locator("#share").boundingBox();
    await page.evaluate(() => { window.clicks = 0; document.querySelector("#share").addEventListener("click", () => window.clicks++); });
    await page.mouse.move(box.x + box.width - 5, box.y + 7);
    assert.equal(await page.locator('[role="tooltip"]').evaluate((el) => getComputedStyle(el).visibility), "visible");
    assert.match(await page.locator('[role="tooltip"]').textContent(), /blocked restarts: 12/);
    assert.equal(await page.evaluate(() => {
      const tooltip = document.querySelector('[role="tooltip"]');
      const rect = tooltip.getBoundingClientRect();
      const nativeLayer = document.createElement("div");
      nativeLayer.style.cssText = `position:fixed;z-index:10000;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:black;`;
      document.body.append(nativeLayer);
      // Enable hit testing just for this stacking-order assertion.
      tooltip.style.pointerEvents = "auto";
      const above = tooltip.contains(document.elementFromPoint(rect.left + 5, rect.top + 5));
      tooltip.style.pointerEvents = "none";
      nativeLayer.remove();
      return above;
    }), true, "fix tooltip must render above the native tooltip layer");
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
    // Hide, refresh and reveal synchronously: no interval or pointer event may rescue visibility.
    assert.equal(await page.evaluate(() => {
      const panel = document.querySelector("main");
      const dot = document.querySelector('[data-soundshare-fix]');
      panel.style.opacity = "0";
      window.indicatorTest.refresh();
      const hidden = !dot.checkVisibility({ checkOpacity: true });
      panel.style.opacity = "1";
      return hidden && dot.checkVisibility({ checkOpacity: true });
    }), true, "dot must follow panel opacity without waiting for refresh");
    await page.evaluate(() => { document.querySelector('[data-soundshare-fix]').remove(); window.indicatorTest.refresh(); });
    assert.equal(await page.locator('#share > [data-soundshare-fix]').count(), 1);
    assert.equal(await page.evaluate(() => {
      const button = document.querySelector("#share");
      const dot = document.querySelector('[data-soundshare-fix]');
      button.style.display = "none";
      window.indicatorTest.refresh();
      const hidden = !dot.checkVisibility();
      button.style.display = "grid";
      return hidden && dot.checkVisibility();
    }), true, "dot must follow button display without waiting for refresh");
    await page.evaluate(() => {
      const panel = document.createElement("section");
      panel.id = "compact";
      panel.innerHTML = `<button id="compact-share"><span aria-label="Share your screen">▰</span></button>
        <span id="compact-label" hidden>Share Your Screen</span><button id="labelled-share" aria-labelledby="compact-label">▰</button>
        <span title="Share Your Screen"><button id="wrapped-share">▰</button></span>
        <button id="described-share" data-migration-pending="true" aria-pressed="false" aria-describedby="compact-description" type="button"><div><span>▰</span></div></button>
        <span id="compact-description" hidden>Share Your Screen</span>
        <button id="described-camera" aria-describedby="camera-description">▰</button><span id="camera-description" hidden>Turn On Camera</span>
        <button id="unrelated" aria-label="Watch Stream">▰</button>`;
      document.body.append(panel);
      window.statusFixture = { state: 1, hits: 4, blocked: 1 };
      window.indicatorTest.refresh();
    });
    for (const id of ["compact-share", "labelled-share", "wrapped-share", "described-share"]) {
      assert.equal(await page.locator(`#${id} > [data-soundshare-fix]`).getAttribute("data-state"), "active");
    }
    assert.equal(await page.locator('#unrelated > [data-soundshare-fix]').count(), 0);
    assert.equal(await page.locator('#described-camera > [data-soundshare-fix]').count(), 0);
    const describedTooltip = await page.locator('#described-share').getAttribute("aria-describedby");
    await page.evaluate(() => { window.indicatorTest.refresh(); window.indicatorTest.refresh(); });
    assert.equal(await page.locator('#described-share').getAttribute("aria-describedby"), describedTooltip, "own tooltip must not break identification or recreate the badge");
    assert.equal(await page.locator('#described-share > [data-soundshare-fix]').count(), 1);
    await page.evaluate(() => { window.statusFixture = { state: -1 }; window.indicatorTest.refresh(); });
    assert.equal(await page.locator('#compact-share > [data-soundshare-fix]').getAttribute("data-state"), "error");
    await page.evaluate(() => window.indicatorTest.stop());
    assert.equal(await page.locator('#described-share').getAttribute("aria-describedby"), "compact-description");
    assert.equal(await page.locator('[data-soundshare-fix]').count(), 0);
    assert.equal(await page.locator('[role="tooltip"]').count(), 0);
    assert.equal(await page.locator("#share").getAttribute("aria-describedby"), "existing");
    assert.equal(await page.locator("#share").evaluate((el) => el.style.position), "");
    if (process.env.INDICATOR_PANEL_FIXTURE) {
      await page.route("**/*", (route) => route.abort());
      await page.setContent(await fs.readFile(process.env.INDICATOR_PANEL_FIXTURE, "utf8"));
      await page.addScriptTag({ content: `(() => { const module = { exports: {} }; ${source}
        window.indicatorTest = module.exports.mountIndicator({document, window, readStatus: () => ({state:1,hits:4,blocked:1})}); })();` });
      await page.evaluate(() => { window.indicatorTest.refresh(); window.indicatorTest.refresh(); });
      assert.equal(await page.locator('[data-soundshare-fix="indicator"]').count(), 1);
      const originalDescription = await page.locator('[data-soundshare-fix="indicator"]').evaluate((dot) => {
        return dot.parentElement.getAttribute("aria-describedby").split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter((el) => el && el.dataset.soundshareFixTooltip !== "true")
          .map((el) => el.textContent).join(" ");
      });
      assert.equal(originalDescription, "Share Your Screen");
      await page.evaluate(() => window.indicatorTest.stop());
      console.log("Provided panel HTML: exactly the screen-share button receives the indicator.");
    }
    console.log("Browser checks passed: placement, tooltip, original click, state changes, keyboard, cleanup and rerender.");
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
