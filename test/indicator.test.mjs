import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { injectIndicator, installIndicator, inspectIndicator, uninstallIndicator } from "../lib/indicator-installer.mjs";
const { describeStatus, isShareButton } = createRequire(import.meta.url)("../runtime/indicator.cjs");
const original = `"use strict";\nconst VoiceEngine = require('./discord_voice.node');\nmodule.exports = VoiceEngine;\n`;

test("only a verified hook is green; missing telemetry is unknown", () => {
  for (const state of [-3, -2, -1, 0, 2, 3, 4, 5]) assert.notEqual(describeStatus({ state }).kind, "active");
  assert.equal(describeStatus({ state: 1, hits: 4, blocked: 1 }).kind, "active");
  assert.match(describeStatus({ state: 1, hits: 4, blocked: 1 }).text, /Signals: 4 · blocked restarts: 1/);
  assert.equal(describeStatus(null).kind, "unknown");
});
test("exact accessible button names, never substring or class guesses", () => {
  for (const name of ["Stop Streaming", "Share Your Screen", "Остановить трансляцию"]) {
    assert.equal(isShareButton({ getAttribute: () => name }), true);
  }
  for (const name of ["Watch Stream", "Stream Settings", "Stop Streaming someone else", null]) {
    assert.equal(isShareButton({ getAttribute: () => name }), false);
  }
});
test("unknown module wrapper and unmanaged marker are rejected", () => {
  assert.throws(() => injectIndicator("unrecognized wrapper"));
  assert.throws(() => injectIndicator(injectIndicator(original)));
});
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "soundshare-indicator-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = { moduleDirectory: dir, indexPath: path.join(dir, "index.js") };
  await fs.writeFile(target.indexPath, original);
  const addonPath = path.join(dir, "fixture.node");
  await fs.writeFile(addonPath, "fixture bridge");
  return { target, options: { addonPath } };
}
test("indicator install, update and uninstall preserve the original wrapper", async (t) => {
  const { target, options } = await fixture(t);
  assert.equal((await inspectIndicator(target)).installed, false);
  await installIndicator(target, options);
  const patched = await fs.readFile(target.indexPath, "utf8");
  assert.equal((await inspectIndicator(target)).installed, true);
  await installIndicator(target, options);
  assert.equal(await fs.readFile(target.indexPath, "utf8"), patched);
  assert.equal(await uninstallIndicator(target), true);
  assert.equal(await fs.readFile(target.indexPath, "utf8"), original);
  assert.equal(await uninstallIndicator(target), false);
  await installIndicator(target, options);
  assert.equal((await inspectIndicator(target)).installed, true);
});
test("changed wrapper is detected and never overwritten", async (t) => {
  const { target, options } = await fixture(t);
  await installIndicator(target, options);
  await fs.appendFile(target.indexPath, "\n// user change\n");
  assert.equal((await inspectIndicator(target)).installed, false);
  await assert.rejects(installIndicator(target, options), /changed/);
  await assert.rejects(uninstallIndicator(target), /changed/);
});
test("corrupt backup is detected and never restored", async (t) => {
  const { target, options } = await fixture(t);
  await installIndicator(target, options);
  await fs.writeFile(`${target.indexPath}.soundshare-indicator.backup`, "bad");
  assert.equal((await inspectIndicator(target)).installed, false);
  await assert.rejects(installIndicator(target, options), /checksum/);
  await assert.rejects(uninstallIndicator(target), /checksum/);
});
