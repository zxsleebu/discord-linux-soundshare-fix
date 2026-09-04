import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BACKUP_FILE,
  MARKER_START,
  PAYLOAD_DIRECTORY,
  PRELOAD_DESKTOP_MARKER,
  PRELOAD_LIBRARY_FILE,
  discoverInstalls,
  inspectPreloadInstallation,
  injectPatch,
  installPreload,
  installTarget,
  makePreloadLauncher,
  patchDesktopEntry,
  sha256File,
  targetFromPath,
  uninstallPreload,
  uninstallTarget,
} from "../lib/installer.mjs";

const stockIndex = `"use strict";
const VoiceEngine = require('./discord_voice.node');
const path = require('path');
module.exports = VoiceEngine;
`;

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-soundshare-fix-test-"));
  const moduleDirectory = path.join(root, "discord_voice");
  const runtimeDirectory = path.join(root, "runtime");
  await fs.mkdir(moduleDirectory, { recursive: true });
  await fs.mkdir(runtimeDirectory, { recursive: true });

  const voiceModulePath = path.join(moduleDirectory, "discord_voice.node");
  const nativeAddonPath = path.join(root, "discord_soundshare_fix.node");
  await fs.writeFile(path.join(moduleDirectory, "index.js"), stockIndex);
  await fs.writeFile(voiceModulePath, "fake discord voice module");
  await fs.writeFile(nativeAddonPath, "fake native addon");
  await fs.writeFile(path.join(runtimeDirectory, "register.cjs"), "module.exports = () => {};\n");

  const moduleHash = await sha256File(voiceModulePath);
  const builds = {
    [moduleHash]: {
      label: "Fixture build",
      platform: `${process.platform}-${process.arch}`,
      signalOnSoundshareOffset: "0x1234",
    },
  };
  await fs.writeFile(
    path.join(runtimeDirectory, "supported-builds.json"),
    `${JSON.stringify({ schemaVersion: 1, builds }, null, 2)}\n`,
  );

  return {
    root,
    moduleDirectory,
    runtimeDirectory,
    nativeAddonPath,
    builds,
  };
}

test("injectPatch preserves Discord's wrapper and is idempotent", () => {
  const patched = injectPatch(stockIndex);
  assert.match(patched, /const path = require\('path'\);/);
  assert.match(patched, new RegExp(MARKER_START.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(injectPatch(patched), patched);
});

test("install and uninstall round-trip the original index.js", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const target = await targetFromPath(fixture.moduleDirectory);

  const installed = await installTarget(target, {
    builds: fixture.builds,
    nativeAddonPath: fixture.nativeAddonPath,
    runtimeDirectory: fixture.runtimeDirectory,
  });

  assert.equal(installed.installed, true);
  assert.equal(await fs.readFile(target.backupPath, "utf8"), stockIndex);
  assert.match(await fs.readFile(target.indexPath, "utf8"), /discord-soundshare-fix:start/);
  assert.equal(
    await fs.readFile(path.join(target.payloadDirectory, "discord_soundshare_fix.node"), "utf8"),
    "fake native addon",
  );

  await installTarget(target, {
    builds: fixture.builds,
    nativeAddonPath: fixture.nativeAddonPath,
    runtimeDirectory: fixture.runtimeDirectory,
  });
  assert.equal(await uninstallTarget(target), true);
  assert.equal(await fs.readFile(target.indexPath, "utf8"), stockIndex);
  await assert.rejects(fs.access(path.join(target.moduleDirectory, BACKUP_FILE)));
  await assert.rejects(fs.access(path.join(target.moduleDirectory, PAYLOAD_DIRECTORY)));
});

test("unsupported modules are rejected before index.js is changed", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const target = await targetFromPath(fixture.moduleDirectory);

  await assert.rejects(
    installTarget(target, {
      builds: {},
      nativeAddonPath: fixture.nativeAddonPath,
      runtimeDirectory: fixture.runtimeDirectory,
    }),
    /Unsupported discord_voice\.node/,
  );
  assert.equal(await fs.readFile(target.indexPath, "utf8"), stockIndex);
  await assert.rejects(fs.access(target.backupPath));
});

test("discovery selects the newest app directory per channel", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-soundshare-discovery-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  for (const version of ["1.0.155", "1.0.156"]) {
    const moduleDirectory = path.join(
      root,
      ".config",
      "discord",
      `app-${version}`,
      "modules",
      "discord_voice-1",
      "discord_voice",
    );
    await fs.mkdir(moduleDirectory, { recursive: true });
    await fs.writeFile(path.join(moduleDirectory, "discord_voice.node"), version);
  }

  const targets = await discoverInstalls({ homeDirectory: root });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].channel, "stable");
  assert.equal(targets[0].appVersion, "1.0.156");
});

test("desktop override keeps the app identity and wraps every launch command", () => {
  const source = `[Desktop Entry]
Name=Discord
Exec=/usr/bin/discord --url -- %u
Icon=discord
StartupWMClass=discord

[Desktop Action Quit]
Exec=/usr/bin/discord --quit
`;
  const patched = patchDesktopEntry(source, "/home/test/.local/share/discord-soundshare-fix/launch");
  assert.match(patched, new RegExp(`^${PRELOAD_DESKTOP_MARKER}`, "m"));
  assert.match(patched, /^Name=Discord$/m);
  assert.match(patched, /^Icon=discord$/m);
  assert.match(patched, /^StartupWMClass=discord$/m);
  assert.equal((patched.match(/^Exec=.*discord-soundshare-fix\/launch.*\/usr\/bin\/discord/gm) ?? []).length, 2);
});

test("preload launcher preserves an existing LD_PRELOAD value", () => {
  const script = makePreloadLauncher("/home/test/lib fix.so");
  assert.match(script, /fix_library='\/home\/test\/lib fix\.so'/);
  assert.match(script, /LD_PRELOAD/);
  assert.match(script, /exec "\$@"/);
});

test("transparent preload install is idempotent and uninstall restores user overrides", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-soundshare-preload-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataHome = path.join(root, "user-data");
  const systemData = path.join(root, "system-data");
  const applications = path.join(dataHome, "applications");
  const systemApplications = path.join(systemData, "applications");
  const autostartDirectory = path.join(root, ".config", "autostart");
  const library = path.join(root, PRELOAD_LIBRARY_FILE);
  const stableDesktop = `[Desktop Entry]\nName=Discord\nExec=/usr/bin/discord --url -- %u\nIcon=discord\n`;
  const canaryDesktop = `[Desktop Entry]\nName=Discord Canary\nExec=/usr/bin/discord-canary\nIcon=discord-canary\n`;
  const stableAutostart = `[Desktop Entry]\nName=Discord\nExec=/opt/discord/Discord\nIcon=discord\n`;
  await fs.mkdir(applications, { recursive: true });
  await fs.mkdir(systemApplications, { recursive: true });
  await fs.mkdir(autostartDirectory, { recursive: true });
  await fs.writeFile(path.join(systemApplications, "discord.desktop"), stableDesktop);
  await fs.writeFile(path.join(applications, "discord-canary.desktop"), canaryDesktop);
  await fs.writeFile(path.join(autostartDirectory, "discord.desktop"), stableAutostart);
  await fs.writeFile(library, "fake preload library");

  const options = {
    channels: ["stable", "canary"],
    homeDirectory: root,
    dataHome,
    systemDataDirectories: [systemData],
    preloadLibraryPath: library,
  };
  const first = await installPreload(options);
  assert.deepEqual(first.entries.map((entry) => entry.channel), ["canary", "stable", "stable"]);
  assert.equal((await inspectPreloadInstallation({ homeDirectory: root, dataHome })).installed, true);
  assert.match(await fs.readFile(path.join(applications, "discord.desktop"), "utf8"), /discord-soundshare-fix:preload/);
  assert.match(await fs.readFile(path.join(applications, "discord-canary.desktop"), "utf8"), /discord-soundshare-fix:preload/);
  assert.match(await fs.readFile(path.join(autostartDirectory, "discord.desktop"), "utf8"), /discord-soundshare-fix:preload/);

  await installPreload(options);
  const removedStable = await uninstallPreload({ channels: ["stable"], homeDirectory: root, dataHome });
  assert.equal(removedStable.length, 2);
  await assert.rejects(fs.access(path.join(applications, "discord.desktop")));
  assert.equal(await fs.readFile(path.join(autostartDirectory, "discord.desktop"), "utf8"), stableAutostart);
  assert.match(await fs.readFile(path.join(applications, "discord-canary.desktop"), "utf8"), /discord-soundshare-fix:preload/);

  const removedCanary = await uninstallPreload({ channels: ["canary"], homeDirectory: root, dataHome });
  assert.equal(removedCanary.length, 1);
  assert.equal(await fs.readFile(path.join(applications, "discord-canary.desktop"), "utf8"), canaryDesktop);
  await assert.rejects(fs.access(path.join(dataHome, PAYLOAD_DIRECTORY)));
});
