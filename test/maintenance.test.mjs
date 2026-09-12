import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import { makePreloadLauncher, targetFromPath, inspectPreloadInstallation, installPreload, uninstallPreload } from "../lib/installer.mjs";
import { installIndicator, inspectIndicator } from "../lib/indicator-installer.mjs";
import { installMaintenance, uninstallMaintenance, inspectMaintenance, maintenancePaths, checkMaintenance, hash, autostartUnitName, autostartArguments, systemdQuote } from "../lib/maintenance.mjs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stock = `"use strict";\nconst VoiceEngine = require('./discord_voice.node');\nmodule.exports = VoiceEngine;\n`;
async function put(file, text) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
async function fixture(t) {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "soundshare-maintenance-"));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const dataHome = path.join(homeDirectory, ".local/share");
  const p = maintenancePaths({ homeDirectory, dataHome });
  const sourceRoot = path.join(homeDirectory, "source");
  for (const file of ["lib/installer.mjs", "lib/indicator-installer.mjs", "lib/maintenance.mjs", "bin/maintenance.mjs", "runtime/indicator.cjs"]) await put(path.join(sourceRoot, file), await fs.readFile(path.join(repo, file)));
  await put(path.join(sourceRoot, "dist/discord_soundshare_fix_status.node"), "fixture addon");
  await put(path.join(sourceRoot, "dist/discord_soundshare_fix_inspect"), "fixture inspector");
  const libraryPath = path.join(p.payload, "libdiscord_soundshare_fix_preload.so");
  const launcherPath = path.join(p.payload, "discord-soundshare-fix-launch");
  const desktopPath = path.join(dataHome, "applications/discord.desktop");
  const autoPath = path.join(homeDirectory, ".config/autostart/discord.desktop");
  const desktop = `[Desktop Entry]\nExec="${launcherPath}" /usr/bin/true\n`;
  const originalDesktop = "[Desktop Entry]\nExec=/usr/bin/true\n";
  await put(libraryPath, "fixture library");
  await put(launcherPath, makePreloadLauncher(libraryPath));
  await put(desktopPath, desktop);
  await put(autoPath, originalDesktop);
  await put(path.join(p.payload, "preload-installation.json"), JSON.stringify({ schemaVersion: 1, libraryPath, launcherPath, entries: [
    { channel: "stable", kind: "application", desktopId: "discord.desktop", destinationPath: desktopPath, patchedSha256: hash(desktop), originalSha256: hash(originalDesktop) },
    { channel: "stable", kind: "autostart", desktopId: "discord.desktop", destinationPath: autoPath },
  ] }));
  const options = { homeDirectory, dataHome, sourceRoot, nodePath: process.execPath, binaries: { stable: "/usr/bin/true" } };
  const config = await installMaintenance(options);
  const target = await newVersion(homeDirectory, "1.0.157");
  return { ...p, options, config, target, launcherPath, libraryPath, desktopPath, autoPath, originalDesktop };
}
async function newVersion(homeDirectory, version, source = stock) {
  const directory = path.join(homeDirectory, ".config/discord", `app-${version}`, "modules/discord_voice-1/discord_voice");
  await put(path.join(directory, "index.js"), source);
  await put(path.join(directory, "discord_voice.node"), "fixture ELF bytes");
  return await targetFromPath(directory);
}
function runner(config, notifications = [], additions = {}) {
  return (now) => checkMaintenance(config, { now, compatibilityCheck: async () => true, liveCheck: async () => [], notify: async (message) => notifications.push(message), ...additions });
}
test("systemd names and quoting are deterministic; only recognized startup commands are accepted", () => {
  assert.equal(autostartUnitName("discord.desktop"), "app-discord@autostart.service");
  assert.equal(autostartUnitName("discord-canary.desktop"), "app-discord\\x2dcanary@autostart.service");
  assert.throws(() => autostartUnitName("../discord.desktop"));
  assert.equal(systemdQuote("/tmp/a %b $c"), '"/tmp/a %%b $$c"');
  const info = { binary: "/usr/bin/discord", directory: "discord" };
  assert.deepEqual(autostartArguments("Exec=/home/test/.config/discord/app-1.0.157/Discord --start-minimized", info, "/home/test", "/fix"), ["--start-minimized"]);
  assert.throws(() => autostartArguments("Exec=/custom/script --foo", info, "/home/test", "/fix"));
});
test("installation is idempotent; systemd guard does not edit or duplicate native autostart", async (t) => {
  const f = await fixture(t);
  assert.equal((await inspectMaintenance(f.options)).installed, true);
  assert.equal((await inspectPreloadInstallation(f.options)).installed, true);
  await assert.rejects(installPreload({ ...f.options, preloadLibraryPath: f.libraryPath }), /maintenance-uninstall/);
  await assert.rejects(uninstallPreload(f.options), /maintenance-uninstall/);
  assert.equal(await fs.readFile(f.autoPath, "utf8"), f.originalDesktop);
  assert.match(await fs.readFile(f.config.guards[0].path, "utf8"), /ExecStart=\nExecStart=.*soundshare-fix-launch/);
  assert.match(await fs.readFile(f.launcherPath, "utf8"), /preflight/);
  await installMaintenance(f.options);
  await uninstallMaintenance(f.options);
  assert.equal(await fs.readFile(f.launcherPath, "utf8"), makePreloadLauncher(f.libraryPath));
  assert.equal(await fs.readFile(f.autoPath, "utf8"), f.originalDesktop);
  assert.equal((await inspectMaintenance(f.options)).installed, false);
});
test("new version waits for stable files, then installs indicator; unchanged checks stay quiet", async (t) => {
  const f = await fixture(t); const notices = []; const run = runner(f.config, notices);
  assert.equal((await run(1000)).pending, true);
  assert.equal((await inspectIndicator(f.target)).installed, false);
  await run(2000);
  assert.equal((await inspectIndicator(f.target)).installed, false);
  await run(3100);
  assert.equal((await inspectIndicator(f.target)).installed, true);
  await run(6000);
  assert.equal(notices.length, 1);
  const newer = await newVersion(f.homeDirectory, "1.0.158");
  await run(7000); await run(9100);
  assert.equal((await inspectIndicator(newer)).installed, true);
  assert.equal(notices.length, 2);
});
test("ongoing updater writes reset the settle window", async (t) => {
  const f = await fixture(t); const run = runner(f.config);
  await run(0);
  await fs.appendFile(f.target.indexPath, "\n// update\n");
  await run(1900); await run(2500);
  assert.equal((await inspectIndicator(f.target)).installed, false);
  await run(4000);
  assert.equal((await inspectIndicator(f.target)).installed, true);
});
test("byte-identical stock restoration can be repaired but arbitrary edits cannot", async (t) => {
  const f = await fixture(t); const notices = []; const run = runner(f.config, notices);
  await run(0); await run(2100);
  await fs.writeFile(f.target.indexPath, stock);
  await run(3000); await run(5100);
  assert.equal((await inspectIndicator(f.target)).installed, true);
  const custom = stock + "\n// custom change\n";
  await fs.writeFile(f.target.indexPath, custom);
  await run(6000); await run(8100); await run(11000);
  assert.equal(await fs.readFile(f.target.indexPath, "utf8"), custom);
  assert.equal(notices.filter((text) => text.includes("repair skipped")).length, 1);
});
test("modified indicator payload is not silently overwritten", async (t) => {
  const f = await fixture(t); const run = runner(f.config);
  await run(0); await run(2100);
  const file = path.join(f.target.moduleDirectory, "discord-soundshare-indicator/indicator.cjs");
  await fs.writeFile(file, "// custom payload");
  await run(3000); await run(5100);
  assert.equal(await fs.readFile(file, "utf8"), "// custom payload");
});
test("missing library and known original menu entry are restored; changed library is preserved", async (t) => {
  const f = await fixture(t); const notices = []; const run = runner(f.config, notices);
  await fs.unlink(f.libraryPath); await fs.writeFile(f.desktopPath, f.originalDesktop);
  await fs.writeFile(f.launcherPath, makePreloadLauncher(f.libraryPath));
  await run(0);
  assert.equal(await fs.readFile(f.libraryPath, "utf8"), "fixture library");
  assert.match(await fs.readFile(f.desktopPath, "utf8"), /soundshare-fix-launch/);
  assert.match(await fs.readFile(f.launcherPath, "utf8"), /preflight/);
  await fs.writeFile(f.libraryPath, "different library"); await run(1000); await run(1100);
  assert.equal(await fs.readFile(f.libraryPath, "utf8"), "different library");
  assert.equal(notices.filter((text) => text.startsWith("Preload library changed")).length, 1);
});
test("unknown wrapper is untouched and warning is deduplicated", async (t) => {
  const f = await fixture(t); const notices = []; const run = runner(f.config, notices);
  await fs.writeFile(f.target.indexPath, "unknown new module wrapper");
  await run(0); await run(2100); await run(5000);
  assert.equal(await fs.readFile(f.target.indexPath, "utf8"), "unknown new module wrapper");
  assert.equal(notices.length, 1);
});
test("incompatible native module produces an update warning, not a success claim", async (t) => {
  const f = await fixture(t); const notices = []; const run = runner(f.config, notices, { compatibilityCheck: async () => false });
  await run(0); await run(2100); await run(5000);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /incompatible/);
});
test("runtime bypass is reported once and never triggers a process restart", async (t) => {
  const f = await fixture(t); const notices = [];
  await installIndicator(f.target, { runtimeDirectory: path.join(f.bundle, "runtime"), addonPath: path.join(f.bundle, "dist/discord_soundshare_fix_status.node") });
  const run = runner(f.config, notices, { liveCheck: async () => ["stable"] });
  await run(0); await run(500); await run(2100); await run(4000);
  assert.equal(notices.length, 1); assert.match(notices[0], /running without/);
});
test("uninstall and reinstall refuse to clobber modified managed configuration", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.config.guards[0].path, "\n# user change\n");
  await assert.rejects(uninstallMaintenance(f.options), /changed/);
  await assert.rejects(installMaintenance(f.options), /changed/);
  assert.match(await fs.readFile(f.launcherPath, "utf8"), /preflight/);
});

test("parallel launcher preflights use a real lock and produce exactly one injection", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.config.configPath, JSON.stringify({ ...f.config, notifications: false }));
  await Promise.all([1, 2].map(() => exec(process.execPath, [f.config.script, "preflight", f.config.configPath], { timeout: 20000 })));
  assert.equal((await inspectIndicator(f.target)).installed, true);
  const source = await fs.readFile(f.target.indexPath, "utf8");
  assert.equal((source.match(/require\("\.\/discord-soundshare-indicator\/indicator.cjs"\)/g) || []).length, 1);
  assert.equal(await fs.readFile(`${f.target.indexPath}.soundshare-indicator.backup`, "utf8"), stock);
});
