import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BACKUP_FILE,
  MARKER_START,
  PAYLOAD_DIRECTORY,
  discoverInstalls,
  injectPatch,
  installTarget,
  sha256File,
  targetFromPath,
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
