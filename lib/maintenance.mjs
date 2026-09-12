// SPDX-License-Identifier: MIT
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverInstalls, makePreloadLauncher, PAYLOAD_DIRECTORY, PRELOAD_METADATA_FILE } from "./installer.mjs";
import { inspectIndicator, installIndicator } from "./indicator-installer.mjs";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MAINTENANCE_FILE = "maintenance.json";
export const SERVICE_NAME = "discord-soundshare-fix-maintenance.service";
export const hash = (value) => createHash("sha256").update(value).digest("hex");
const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
export const systemdQuote = (value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", () => "$$")}"`;
const channelsInfo = {
  stable: { binary: "/usr/bin/discord", directory: "discord" },
  canary: { binary: "/usr/bin/discord-canary", directory: "discordcanary" },
  ptb: { binary: "/usr/bin/discord-ptb", directory: "discordptb" },
};
export function maintenancePaths({ homeDirectory = os.homedir(), dataHome = process.env.XDG_DATA_HOME || path.join(homeDirectory, ".local/share") } = {}) {
  const payload = path.join(dataHome, PAYLOAD_DIRECTORY);
  return { homeDirectory, dataHome, payload, configPath: path.join(payload, MAINTENANCE_FILE), bundle: path.join(payload, "maintenance") };
}
async function optionalRead(file) {
  try { return await fs.readFile(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function atomicWrite(file, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  try { await fs.writeFile(temporary, bytes, { mode }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
export function makeMaintenanceLauncher(libraryPath, nodePath, scriptPath, configPath) {
  const original = makePreloadLauncher(libraryPath);
  const check = `# Check only our managed installation; never prevent Discord from opening.\nif [ -r ${shellQuote(scriptPath)} ] && [ -r ${shellQuote(configPath)} ]; then\n  ${shellQuote(nodePath)} ${shellQuote(scriptPath)} preflight ${shellQuote(configPath)} || printf '%s\\n' '[discord-soundshare-fix] maintenance unavailable; continuing launch' >&2\nfi\n\n`;
  return original.replace("fix_library=", () => check + "fix_library=");
}
export function autostartUnitName(desktopId) {
  if (!/^[a-zA-Z0-9_.-]+\.desktop$/.test(desktopId)) throw new Error("Unsupported autostart desktop ID");
  return `app-${desktopId.slice(0, -8).replaceAll("-", "\\x2d")}@autostart.service`;
}

export function autostartArguments(source, info, homeDirectory, launcherPath) {
  let command = /^Exec=(.+)$/m.exec(source)?.[1]?.trim();
  if (!command) throw new Error("Autostart entry has no Exec command");
  const launcher = `"${launcherPath}" `;
  if (command.startsWith(launcher)) command = command.slice(launcher.length);
  const match = /^(?:"([^"]+)"|(\S+))(.*)$/.exec(command);
  const executable = match?.[1] || match?.[2];
  const relative = executable ? path.relative(path.join(homeDirectory, ".config", info.directory), executable).split(path.sep) : [];
  const recognized = executable === info.binary || (relative.length === 2 && /^app-\d+(?:\.\d+)+$/.test(relative[0]) && /^Discord(?:Canary|PTB)?$/.test(relative[1]));
  if (!recognized) throw new Error("Autostart command is customized; refusing to override it");
  const args = match[3].trim() ? match[3].trim().split(/\s+/) : [];
  if (args.some((arg) => !/^--[a-zA-Z0-9-]+(?:=[a-zA-Z0-9_.-]+)?$/.test(arg))) throw new Error("Autostart arguments require manual review");
  return args;
}

export async function installMaintenance({ channels = ["stable"], sourceRoot = root, nodePath = "/usr/bin/node", binaries = {}, ...options } = {}) {
  const p = maintenancePaths(options);
  const metadata = JSON.parse(await fs.readFile(path.join(p.payload, PRELOAD_METADATA_FILE), "utf8"));
  const previousBytes = await optionalRead(p.configPath);
  const previous = previousBytes ? JSON.parse(previousBytes) : null;
  if (previous && JSON.stringify(previous.channels) !== JSON.stringify(channels)) throw new Error("Uninstall maintenance before changing its channel selection");
  if (metadata.launcherPath !== path.join(p.payload, "discord-soundshare-fix-launch") ||
      metadata.libraryPath !== path.join(p.payload, "libdiscord_soundshare_fix_preload.so")) throw new Error("Unexpected preload installation paths");
  await fs.access(nodePath);
  await fs.access("/usr/bin/flock");
  const script = path.join(p.bundle, "bin/maintenance.mjs");
  const managedFiles = [];
  async function plan(file, contents, mode = 0o644, kind = "config") {
    const current = await optionalRead(file);
    const old = previous?.managedFiles.find((entry) => entry.path === file);
    if (old && current && hash(current) !== old.sha256) throw new Error(`Managed file changed: ${file}`);
    if (!old && current && kind !== "launcher") throw new Error(`Refusing to replace existing file: ${file}`);
    if (!old && kind === "launcher" && current?.toString() !== makePreloadLauncher(metadata.libraryPath)) throw new Error("Launcher has unrecognized changes");
    managedFiles.push({ path: file, contents, sha256: hash(contents), mode, kind,
      original: old ? old.original : (current ? current.toString("base64") : null) });
  }
  await plan(metadata.launcherPath, makeMaintenanceLauncher(metadata.libraryPath, nodePath, script, p.configPath), 0o755, "launcher");
  const guards = [];
  for (const channel of channels) {
    if (!channelsInfo[channel]) throw new Error(`Unknown channel: ${channel}`);
    const info = { ...channelsInfo[channel], binary: binaries[channel] ?? channelsInfo[channel].binary };
    await fs.access(info.binary);
    const entry = metadata.entries.find((entry) => entry.channel === channel && entry.kind === "autostart");
    if (!entry) continue; // Never enable autostart for a client which did not have it.
    const unit = autostartUnitName(entry.desktopId);
    const args = autostartArguments(await fs.readFile(entry.destinationPath, "utf8"), info, p.homeDirectory, metadata.launcherPath);
    const file = path.join(p.homeDirectory, ".config/systemd/user", `${unit}.d`, "50-soundshare-fix.conf");
    // The stock unit's conditions and enable/disable setting remain untouched.
    await plan(file, `[Service]\nExecStart=\nExecStart=${[metadata.launcherPath, info.binary, ...args].map(systemdQuote).join(" ")}\n`);
    guards.push({ channel, unit, path: file, desktopPath: entry.destinationPath, args });
  }
  const writable = [p.payload, path.join(p.dataHome, "applications"), ...channels.map((channel) => path.join(p.homeDirectory, ".config", channelsInfo[channel].directory))];
  const servicePath = path.join(p.homeDirectory, ".config/systemd/user", SERVICE_NAME);
  await plan(servicePath, `[Unit]\nDescription=Restore Discord soundshare indicator after updates\n\n[Service]\nType=simple\nExecStart=${systemdQuote(nodePath)} ${systemdQuote(script)} watch ${systemdQuote(p.configPath)}\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${writable.map(systemdQuote).join(" ")}\n\n[Install]\nWantedBy=default.target\n`);
  const bundleFiles = ["lib/installer.mjs", "lib/indicator-installer.mjs", "lib/maintenance.mjs", "bin/maintenance.mjs", "runtime/indicator.cjs"];
  const sources = [];
  for (const file of bundleFiles) sources.push({ file, bytes: await fs.readFile(path.join(sourceRoot, file)) });
  for (const name of ["discord_soundshare_fix_status.node", "discord_soundshare_fix_inspect"]) {
    const bytes = await optionalRead(path.join(sourceRoot, "dist", name)) ?? await fs.readFile(path.join(sourceRoot, "native/build/Release", name));
    sources.push({ file: `dist/${name}`, bytes });
  }
  const library = await fs.readFile(metadata.libraryPath);
  sources.push({ file: "dist/libdiscord_soundshare_fix_preload.so", bytes: library });
  const applications = [];
  for (const entry of metadata.entries.filter((entry) => channels.includes(entry.channel) && entry.kind !== "autostart")) {
    const contents = await fs.readFile(entry.destinationPath, "utf8");
    if (hash(contents) !== entry.patchedSha256) throw new Error(`Desktop launcher needs manual repair: ${entry.destinationPath}`);
    applications.push({ ...entry, contents });
  }
  const config = { schemaVersion: 1, ...p, channels, nodePath, script, managedFiles, guards, applications, binaries,
    notifications: previous?.notifications ?? true,
    indicatorHash: hash(sources.find((source) => source.file === "runtime/indicator.cjs").bytes),
    addonHash: hash(sources.find((source) => source.file === "dist/discord_soundshare_fix_status.node").bytes),
    libraryPath: metadata.libraryPath, libraryHash: hash(library), installedAt: new Date().toISOString() };
  // Every input is validated before the first installation write.
  for (const source of sources) await atomicWrite(path.join(p.bundle, source.file), source.bytes, source.file.endsWith("inspect") ? 0o755 : 0o644);
  // Save backups and ownership before changing the launch paths.
  await atomicWrite(p.configPath, JSON.stringify(config, null, 2));
  for (const entry of managedFiles) await atomicWrite(entry.path, entry.contents, entry.mode);
  return config;
}

export async function inspectMaintenance(options = {}) {
  const p = maintenancePaths(options);
  const bytes = await optionalRead(p.configPath);
  if (!bytes) return { installed: false, files: [], guards: [] };
  const config = JSON.parse(bytes);
  const files = [];
  for (const entry of config.managedFiles) {
    const current = await optionalRead(entry.path);
    files.push({ path: entry.path, valid: !!current && hash(current) === entry.sha256 });
  }
  let state = {};
  try { state = JSON.parse((await optionalRead(path.join(p.payload, "maintenance-state.json")))?.toString() || "{}"); } catch { /* The service may not have produced state yet. */ }
  return { installed: files.length > 0 && files.every((entry) => entry.valid), files, guards: config.guards,
    checkedAt: state.checkedAt, diagnostics: Object.values(state.reported ?? {}) };
}
export async function uninstallMaintenance(options = {}) {
  const p = maintenancePaths(options);
  const bytes = await optionalRead(p.configPath);
  if (!bytes) return false;
  const config = JSON.parse(bytes);
  for (const entry of config.managedFiles) {
    const current = await optionalRead(entry.path);
    if (current && hash(current) !== entry.sha256) throw new Error(`Refusing to overwrite changed file: ${entry.path}`);
  }
  for (const entry of config.managedFiles) {
    if (entry.original !== null) await atomicWrite(entry.path, Buffer.from(entry.original, "base64"), entry.mode);
    else await fs.rm(entry.path, { force: true });
  }
  await fs.unlink(p.configPath);
  return true; // Retain inert bundle/state for diagnosis; never remove the audio fix.
}

export async function fingerprint(target) {
  const bytes = await fs.readFile(target.indexPath);
  const module = await fs.stat(target.voiceModulePath);
  if (module.size < 4) throw new Error("Voice module is incomplete");
  return { sourceHash: hash(bytes), key: `${hash(bytes)}:${module.ino}:${module.size}:${module.mtimeMs}` };
}
export async function checkMaintenance(config, { now = Date.now(), stableMs = 2000, notify = async () => {}, compatibilityCheck, liveCheck = findUnprotectedClients } = {}) {
  const statePath = path.join(config.payload, "maintenance-state.json");
  const previous = await optionalRead(statePath);
  let state;
  try { state = previous ? JSON.parse(previous) : {}; } catch { state = {}; }
  state.pending ??= {};
  state.reported ??= {};
  state.verified ??= {};
  state.compatible ??= {};
  const events = [];
  async function report(key, message) {
    events.push(message);
    if (state.reported[key] === message) return;
    state.reported[key] = message;
    console.log(`[discord-soundshare-fix] ${message}`);
    await notify(message);
  }
  for (const entry of [...config.managedFiles.filter((entry) => entry.kind === "launcher"), ...config.applications.map((entry) => ({ ...entry, path: entry.destinationPath, sha256: entry.patchedSha256, mode: 0o644 }))]) {
    const current = await optionalRead(entry.path);
    if (current && hash(current) === entry.sha256) { delete state.reported[entry.path]; continue; }
    if (!current || (entry.originalSha256 && hash(current) === entry.originalSha256) ||
        (entry.original && hash(current) === hash(Buffer.from(entry.original, "base64")))) {
      await atomicWrite(entry.path, entry.contents, entry.mode);
      await report(entry.path, `Restored launch path: ${path.basename(entry.path)}. Restart Discord from its usual icon if it is already running.`);
    } else await report(entry.path, `Launch file has unrecognized changes; left untouched: ${entry.path}`);
  }
  for (const guard of config.guards) {
    const expected = config.managedFiles.find((entry) => entry.path === guard.path);
    const current = await optionalRead(guard.path);
    if (!current || hash(current) !== expected.sha256) await report(guard.path, `Autostart guard changed; reinstall maintenance: ${guard.unit}`);
    else delete state.reported[guard.path];
    try {
      const source = await optionalRead(guard.desktopPath);
      if (source) {
        const info = { ...channelsInfo[guard.channel], binary: config.binaries?.[guard.channel] ?? channelsInfo[guard.channel].binary };
        const args = autostartArguments(source.toString(), info, config.homeDirectory, path.join(config.payload, "discord-soundshare-fix-launch"));
        if (JSON.stringify(args) !== JSON.stringify(guard.args)) throw new Error("autostart arguments changed");
        delete state.reported[guard.desktopPath];
      }
    } catch (error) { await report(guard.desktopPath, `Autostart customization needs review: ${error.message}. The protected startup command has not been changed.`); }
  }
  const library = await optionalRead(config.libraryPath);
  if (!library) {
    const backup = await fs.readFile(path.join(config.bundle, "dist/libdiscord_soundshare_fix_preload.so"));
    if (hash(backup) !== config.libraryHash) throw new Error("Saved preload library checksum mismatch");
    await atomicWrite(config.libraryPath, backup, 0o755);
    await report("library", "Restored missing soundshare library. Restart Discord from its usual icon.");
  } else if (hash(library) !== config.libraryHash) await report("library", "Preload library changed; left untouched. Reinstall maintenance after an intentional fix update.");
  else delete state.reported.library;
  const targets = (await discoverInstalls({ homeDirectory: config.homeDirectory })).filter((target) => config.channels.includes(target.channel));
  let pending = false;
  for (const target of targets) {
    try {
      const current = await fingerprint(target);
      const status = await inspectIndicator(target);
      const uiDirectory = path.join(target.moduleDirectory, "discord-soundshare-indicator");
      const needsIndicator = !status.installed ||
        hash(await fs.readFile(path.join(uiDirectory, "indicator.cjs"))) !== config.indicatorHash ||
        hash(await fs.readFile(path.join(uiDirectory, "discord_soundshare_fix_status.node"))) !== config.addonHash;
      if (!needsIndicator && typeof state.compatible[target.channel] === "boolean" && state.verified[target.channel] === `${target.moduleDirectory}:${current.key}`) {
        delete state.pending[target.channel];
        if (state.compatible[target.channel] !== false) delete state.reported[target.channel];
        continue;
      }
      const old = state.pending[target.channel];
      if (!old || old.directory !== target.moduleDirectory || old.key !== current.key) {
        state.pending[target.channel] = { ...current, directory: target.moduleDirectory, since: now };
        pending = true;
        continue;
      }
      if (now - old.since < stableMs) { pending = true; continue; }
      // Recognized originals can be restored; changed wrappers/backups fail closed.
      if (needsIndicator) await installIndicator(target, { runtimeDirectory: path.join(config.bundle, "runtime"),
        addonPath: path.join(config.bundle, "dist/discord_soundshare_fix_status.node"),
        restoreKnownOriginal: true, expectedSourceHash: current.sourceHash, preservePayloadChanges: true });
      let compatible = true;
      try {
        if (compatibilityCheck) compatible = await compatibilityCheck(target);
        else await exec(path.join(config.bundle, "dist/discord_soundshare_fix_inspect"), [config.libraryPath, target.voiceModulePath], { timeout: 10000 });
      } catch { compatible = false; }
      delete state.pending[target.channel];
      state.verified[target.channel] = `${target.moduleDirectory}:${(await fingerprint(target)).key}`;
      state.compatible[target.channel] = compatible;
      if (needsIndicator || !compatible) await report(target.channel, compatible
        ? `Restored indicator for Discord ${target.channel} ${target.appVersion}. If Discord is already open, fully quit and restart it; calls are not interrupted automatically.`
        : `Discord ${target.channel} ${target.appVersion}: native hook is incompatible. The fix needs an update; reinstalling alone will not help.`);
    } catch (error) { await report(target.channel, `${target.channel}: automatic repair skipped: ${error.message}`); }
  }
  const unprotected = await liveCheck(config);
  for (const channel of config.channels) {
    if (unprotected.includes(channel)) await report(`runtime:${channel}`, `Discord ${channel} is running without the soundshare library. Fully quit and launch from the usual icon; it will not be restarted automatically.`);
    else delete state.reported[`runtime:${channel}`];
  }
  state.checkedAt = new Date(now).toISOString();
  state.events = events;
  await atomicWrite(statePath, JSON.stringify(state, null, 2));
  return { pending, events };
}

export async function findUnprotectedClients(config) {
  let stdout;
  try { ({ stdout } = await exec("pgrep", ["-u", String(process.getuid()), "-x", "Discord|DiscordCanary|DiscordPTB"], { timeout: 2000 })); }
  catch { return []; }
  const result = new Set();
  for (const pid of stdout.trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid))) {
    try {
      const maps = await fs.readFile(`/proc/${pid}/maps`, "utf8");
      if (maps.includes(config.libraryPath)) continue;
      for (const channel of config.channels) {
        const prefix = path.join(config.homeDirectory, ".config", channelsInfo[channel].directory) + "/app-";
        if (maps.split("\n").some((line) => line.includes(prefix) && line.includes("/discord_voice.node"))) result.add(channel);
      }
    } catch { /* Processes can exit during a read; never treat an unreadable map as success/failure. */ }
  }
  return [...result];
}
