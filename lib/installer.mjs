import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_VERSION = "0.3.0";
export const MARKER_START = "// discord-soundshare-fix:start";
export const MARKER_END = "// discord-soundshare-fix:end";
export const PAYLOAD_DIRECTORY = "discord-soundshare-fix";
export const BACKUP_FILE = "index.js.discord-soundshare-fix.backup";
export const PRELOAD_DESKTOP_MARKER = "# discord-soundshare-fix:preload";
export const PRELOAD_LIBRARY_FILE = "libdiscord_soundshare_fix_preload.so";
export const PRELOAD_LAUNCHER_FILE = "discord-soundshare-fix-launch";
export const PRELOAD_METADATA_FILE = "preload-installation.json";

// Update our own library without overwriting desktop/autostart edits made by Discord.
export async function refreshPreloadLibrary({ homeDirectory = os.homedir(), dataHome = defaultDataHome(homeDirectory) } = {}) {
  const payload = path.join(dataHome, PAYLOAD_DIRECTORY);
  const metadata = await loadPreloadMetadata(path.join(payload, PRELOAD_METADATA_FILE));
  const libraryPath = path.join(payload, PRELOAD_LIBRARY_FILE);
  if (!metadata || metadata.libraryPath !== libraryPath || !(await pathExists(libraryPath))) {
    throw new Error("Install the transparent preload fix before installing its indicator");
  }
  const source = await resolvePreloadLibrary();
  const backup = `${libraryPath}.before-indicator`;
  if (!(await pathExists(backup))) await atomicCopy(libraryPath, backup);
  await atomicCopy(source, libraryPath);
  return libraryPath;
}

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRuntimeDirectory = path.join(rootDirectory, "runtime");

const channelLocations = [
  { channel: "stable", configDirectory: "discord" },
  { channel: "canary", configDirectory: "discordcanary" },
  { channel: "ptb", configDirectory: "discordptb" },
];

const desktopIdsByChannel = {
  stable: ["discord.desktop", "com.discordapp.Discord.desktop"],
  canary: ["discord-canary.desktop"],
  ptb: ["discord-ptb.desktop"],
};

export function injectPatch(indexSource) {
  if (indexSource.includes(MARKER_START)) return indexSource;

  const declaration = /^\s*const\s+VoiceEngine\s*=\s*require\((['"])\.\/discord_voice\.node\1\);\s*$/m;
  const match = declaration.exec(indexSource);
  if (!match) {
    throw new Error("Could not find Discord's VoiceEngine declaration in index.js");
  }

  const insertionPoint = match.index + match[0].length;
  const snippet = `
${MARKER_START}
try {
  require("./${PAYLOAD_DIRECTORY}/register.cjs")({
    VoiceEngine,
    nativeModulePath: require("node:path").join(__dirname, "discord_voice.node"),
  });
} catch (error) {
  console.error("[discord-soundshare-fix] failed to load; continuing without the patch", error);
}
${MARKER_END}`;

  return indexSource.slice(0, insertionPoint) + snippet + indexSource.slice(insertionPoint);
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function atomicWrite(filePath, contents, mode = 0o644) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporaryPath, contents, { mode });
  await fs.rename(temporaryPath, filePath);
}

async function atomicCopy(sourcePath, destinationPath) {
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${randomUUID()}`;
  await fs.copyFile(sourcePath, temporaryPath);
  const sourceStat = await fs.stat(sourcePath);
  await fs.chmod(temporaryPath, sourceStat.mode & 0o777);
  await fs.rename(temporaryPath, destinationPath);
}

export async function loadSupportedBuilds(runtimeDirectory = defaultRuntimeDirectory) {
  const manifestPath = path.join(runtimeDirectory, "supported-builds.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || typeof manifest.builds !== "object") {
    throw new Error(`Unsupported build manifest: ${manifestPath}`);
  }
  return manifest.builds;
}

async function findVoiceModuleDirectory(appDirectory) {
  const modulesDirectory = path.join(appDirectory, "modules");
  let entries;
  try {
    entries = await fs.readdir(modulesDirectory, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("discord_voice-"))
    .map((entry) => path.join(modulesDirectory, entry.name, "discord_voice"));

  for (const candidate of candidates) {
    if (await pathExists(path.join(candidate, "discord_voice.node"))) return candidate;
  }
  return null;
}

function makeTarget({ channel, appVersion, moduleDirectory }) {
  return {
    channel,
    appVersion,
    moduleDirectory,
    indexPath: path.join(moduleDirectory, "index.js"),
    voiceModulePath: path.join(moduleDirectory, "discord_voice.node"),
    payloadDirectory: path.join(moduleDirectory, PAYLOAD_DIRECTORY),
    backupPath: path.join(moduleDirectory, BACKUP_FILE),
  };
}

export async function discoverInstalls({ homeDirectory = os.homedir() } = {}) {
  const targets = [];
  const versionSorter = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  for (const location of channelLocations) {
    const configRoot = path.join(homeDirectory, ".config", location.configDirectory);
    let appEntries;
    try {
      appEntries = await fs.readdir(configRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    const appNames = appEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("app-"))
      .map((entry) => entry.name)
      .sort((left, right) => versionSorter.compare(right, left));

    for (const appName of appNames) {
      const moduleDirectory = await findVoiceModuleDirectory(path.join(configRoot, appName));
      if (!moduleDirectory) continue;
      targets.push(makeTarget({
        channel: location.channel,
        appVersion: appName.slice("app-".length),
        moduleDirectory,
      }));
      break;
    }
  }

  return targets;
}

export async function targetFromPath(inputPath) {
  let resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) resolved = path.dirname(resolved);

  if (await pathExists(path.join(resolved, "discord_voice.node"))) {
    return makeTarget({ channel: "custom", appVersion: "unknown", moduleDirectory: resolved });
  }

  const moduleDirectory = await findVoiceModuleDirectory(resolved);
  if (moduleDirectory) {
    const appName = path.basename(resolved);
    return makeTarget({
      channel: "custom",
      appVersion: appName.startsWith("app-") ? appName.slice(4) : "unknown",
      moduleDirectory,
    });
  }

  throw new Error(`Could not find discord_voice.node below ${resolved}`);
}

export async function inspectTarget(target, { builds } = {}) {
  const supportedBuilds = builds ?? await loadSupportedBuilds();
  const moduleHash = await sha256File(target.voiceModulePath);
  const build = supportedBuilds[moduleHash] ?? null;
  const indexSource = await fs.readFile(target.indexPath, "utf8");
  const installed = indexSource.includes(MARKER_START);
  const hasBackup = await pathExists(target.backupPath);

  return {
    ...target,
    moduleHash,
    build,
    supported: build !== null,
    installed,
    hasBackup,
  };
}

export async function resolveNativeAddon(root = rootDirectory) {
  const override = process.env.DISCORD_SOUNDSHARE_FIX_NATIVE;
  const candidates = [
    override,
    path.join(root, "native", "build", "Release", "discord_soundshare_fix.node"),
    path.join(root, "dist", "discord_soundshare_fix.node"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("Native addon is missing. Run `npm install && npm run build` first.");
}

export async function installTarget(target, {
  builds,
  nativeAddonPath,
  runtimeDirectory = defaultRuntimeDirectory,
} = {}) {
  const supportedBuilds = builds ?? await loadSupportedBuilds(runtimeDirectory);
  const state = await inspectTarget(target, { builds: supportedBuilds });
  if (!state.supported) {
    throw new Error(`Unsupported discord_voice.node: ${state.moduleHash}`);
  }
  if (state.build.platform !== `${process.platform}-${process.arch}`) {
    throw new Error(`Build ${state.build.label} is not supported on ${process.platform}-${process.arch}`);
  }

  const addonPath = nativeAddonPath ?? await resolveNativeAddon();
  let indexSource = await fs.readFile(target.indexPath, "utf8");

  if (!state.installed) {
    if (state.hasBackup) {
      throw new Error(`Refusing to overwrite stale backup: ${target.backupPath}`);
    }
    await atomicCopy(target.indexPath, target.backupPath);
    indexSource = injectPatch(indexSource);
  } else if (!state.hasBackup) {
    throw new Error("Patch marker exists, but the original index.js backup is missing");
  }

  await fs.mkdir(target.payloadDirectory, { recursive: true });
  await atomicCopy(addonPath, path.join(target.payloadDirectory, "discord_soundshare_fix.node"));
  await atomicCopy(path.join(runtimeDirectory, "register.cjs"), path.join(target.payloadDirectory, "register.cjs"));
  await atomicCopy(
    path.join(runtimeDirectory, "supported-builds.json"),
    path.join(target.payloadDirectory, "supported-builds.json"),
  );
  await atomicWrite(
    path.join(target.payloadDirectory, "installation.json"),
    `${JSON.stringify({
      toolVersion: TOOL_VERSION,
      installedAt: new Date().toISOString(),
      moduleHash: state.moduleHash,
      build: state.build.label,
    }, null, 2)}\n`,
  );
  await atomicWrite(target.indexPath, indexSource);

  return inspectTarget(target, { builds: supportedBuilds });
}

export async function uninstallTarget(target) {
  const indexSource = await fs.readFile(target.indexPath, "utf8");
  const installed = indexSource.includes(MARKER_START);
  const hasBackup = await pathExists(target.backupPath);

  if (!installed && !hasBackup) return false;
  if (!hasBackup) {
    throw new Error("Cannot uninstall safely: the original index.js backup is missing");
  }

  await atomicCopy(target.backupPath, target.indexPath);
  await fs.unlink(target.backupPath);
  await fs.rm(target.payloadDirectory, { recursive: true, force: true });
  return true;
}

function sha256Text(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function defaultDataHome(homeDirectory) {
  return process.env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share");
}

function defaultSystemDataDirectories() {
  return (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share")
    .split(":")
    .filter(Boolean);
}

function quoteDesktopToken(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$")}"`;
}

function quoteShellLiteral(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function patchDesktopEntry(source, launcherPath) {
  if (source.includes(PRELOAD_DESKTOP_MARKER)) {
    throw new Error("Desktop entry is already managed, but its installation metadata is missing");
  }

  let execCount = 0;
  const launcher = quoteDesktopToken(launcherPath);
  const patched = source.replace(/^Exec=(.+)$/gm, (_line, command) => {
    execCount += 1;
    return `Exec=${launcher} ${command}`;
  });
  if (execCount === 0) throw new Error("Desktop entry does not contain an Exec line");
  return `${PRELOAD_DESKTOP_MARKER}\n${patched}`;
}

export function makePreloadLauncher(libraryPath) {
  return `#!/bin/sh
set -eu

fix_library=${quoteShellLiteral(libraryPath)}
case ":\${LD_PRELOAD-}:" in
  *":$fix_library:"*) ;;
  *) export LD_PRELOAD="$fix_library\${LD_PRELOAD:+:$LD_PRELOAD}" ;;
esac

exec "$@"
`;
}

export async function resolvePreloadLibrary(root = rootDirectory) {
  const override = process.env.DISCORD_SOUNDSHARE_FIX_PRELOAD;
  const candidates = [
    override,
    path.join(root, "native", "build", "Release", PRELOAD_LIBRARY_FILE),
    path.join(root, "native", "build", "Release", "discord_soundshare_fix_preload.so"),
    path.join(root, "dist", PRELOAD_LIBRARY_FILE),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new Error("Preload library is missing. Run `npm install && npm run build` first.");
}

async function loadPreloadMetadata(metadataPath) {
  try {
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    if (metadata.schemaVersion !== 1 || !Array.isArray(metadata.entries)) {
      throw new Error("unsupported schema");
    }
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Cannot read preload installation metadata: ${error.message}`);
  }
}

async function findDesktopSource({ channel, dataHome, systemDataDirectories }) {
  const desktopIds = desktopIdsByChannel[channel];
  if (!desktopIds) throw new Error(`Unknown Discord channel: ${channel}`);

  const applicationsDirectory = path.join(dataHome, "applications");
  for (const desktopId of desktopIds) {
    const userPath = path.join(applicationsDirectory, desktopId);
    if (await pathExists(userPath)) {
      return { desktopId, sourcePath: userPath, userOverride: true };
    }
  }
  for (const dataDirectory of systemDataDirectories) {
    for (const desktopId of desktopIds) {
      const systemPath = path.join(dataDirectory, "applications", desktopId);
      if (await pathExists(systemPath)) {
        return { desktopId, sourcePath: systemPath, userOverride: false };
      }
    }
  }
  return null;
}

export async function installPreload({
  channels = Object.keys(desktopIdsByChannel),
  homeDirectory = os.homedir(),
  dataHome = defaultDataHome(homeDirectory),
  systemDataDirectories = defaultSystemDataDirectories(),
  preloadLibraryPath,
} = {}) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("The transparent preload installer currently supports Linux x86_64 only");
  }

  const sourceLibrary = preloadLibraryPath ?? await resolvePreloadLibrary();
  const payloadDirectory = path.join(dataHome, PAYLOAD_DIRECTORY);
  if (await pathExists(path.join(payloadDirectory, "maintenance.json"))) {
    throw new Error("Run maintenance-uninstall before reinstalling the base preload launcher");
  }
  const applicationsDirectory = path.join(dataHome, "applications");
  const backupsDirectory = path.join(payloadDirectory, "desktop-backups");
  const libraryPath = path.join(payloadDirectory, PRELOAD_LIBRARY_FILE);
  const launcherPath = path.join(payloadDirectory, PRELOAD_LAUNCHER_FILE);
  const metadataPath = path.join(payloadDirectory, PRELOAD_METADATA_FILE);
  const previous = await loadPreloadMetadata(metadataPath);
  const entryKey = (entry) => `${entry.channel}:${entry.kind ?? "application"}`;
  const entriesByKey = new Map((previous?.entries ?? []).map((entry) => [entryKey(entry), entry]));
  const planned = [];

  for (const channel of [...new Set(channels)]) {
    const existingEntries = [...entriesByKey.values()].filter((entry) => entry.channel === channel);
    for (const existingEntry of existingEntries) {
      const current = await fs.readFile(existingEntry.destinationPath, "utf8");
      if (sha256Text(current) !== existingEntry.patchedSha256) {
        throw new Error(`Managed desktop entry changed after installation: ${existingEntry.destinationPath}`);
      }
      const originalPath = existingEntry.backupPath || existingEntry.sourcePath;
      const original = await fs.readFile(originalPath, "utf8");
      planned.push({
        ...existingEntry,
        original,
        patched: patchDesktopEntry(original, launcherPath),
      });
    }

    if (!existingEntries.some((entry) => (entry.kind ?? "application") === "application")) {
      const source = await findDesktopSource({ channel, dataHome, systemDataDirectories });
      if (source) {
        const original = await fs.readFile(source.sourcePath, "utf8");
        if (original.includes(PRELOAD_DESKTOP_MARKER)) {
          throw new Error(`Refusing to replace an unmanaged preload override: ${source.sourcePath}`);
        }
        if (/^Exec=.*\bflatpak\b/m.test(original)) {
          throw new Error(`Flatpak Discord requires a different sandbox-aware installation method: ${source.sourcePath}`);
        }

        const destinationPath = path.join(applicationsDirectory, source.desktopId);
        const backupPath = source.userOverride
          ? path.join(backupsDirectory, `${channel}-application-${source.desktopId}`)
          : null;
        planned.push({
          channel,
          kind: "application",
          desktopId: source.desktopId,
          sourcePath: source.sourcePath,
          destinationPath,
          backupPath,
          original,
          patched: patchDesktopEntry(original, launcherPath),
        });
      }
    }

    if (!existingEntries.some((entry) => entry.kind === "autostart")) {
      for (const desktopId of desktopIdsByChannel[channel]) {
        const autostartPath = path.join(homeDirectory, ".config", "autostart", desktopId);
        if (!(await pathExists(autostartPath))) continue;
        const original = await fs.readFile(autostartPath, "utf8");
        if (original.includes(PRELOAD_DESKTOP_MARKER)) {
          throw new Error(`Refusing to replace an unmanaged preload override: ${autostartPath}`);
        }
        planned.push({
          channel,
          kind: "autostart",
          desktopId,
          sourcePath: autostartPath,
          destinationPath: autostartPath,
          backupPath: path.join(backupsDirectory, `${channel}-autostart-${desktopId}`),
          original,
          patched: patchDesktopEntry(original, launcherPath),
        });
        break;
      }
    }
  }

  if (planned.length === 0) throw new Error("No native Discord desktop entries were found");

  await fs.mkdir(payloadDirectory, { recursive: true });
  await fs.mkdir(applicationsDirectory, { recursive: true });
  await fs.mkdir(backupsDirectory, { recursive: true });
  await atomicCopy(sourceLibrary, libraryPath);
  await fs.chmod(libraryPath, 0o755);
  await atomicWrite(launcherPath, makePreloadLauncher(libraryPath), 0o755);

  for (const entry of planned) {
    if (entry.backupPath && !(await pathExists(entry.backupPath))) {
      await atomicWrite(entry.backupPath, entry.original);
    }
    await atomicWrite(entry.destinationPath, entry.patched);
    const storedEntry = {
      channel: entry.channel,
      kind: entry.kind ?? "application",
      desktopId: entry.desktopId,
      sourcePath: entry.sourcePath,
      destinationPath: entry.destinationPath,
      backupPath: entry.backupPath,
      originalSha256: sha256Text(entry.original),
      patchedSha256: sha256Text(entry.patched),
    };
    entriesByKey.set(entryKey(storedEntry), storedEntry);
  }

  const metadata = {
    schemaVersion: 1,
    toolVersion: TOOL_VERSION,
    installedAt: new Date().toISOString(),
    libraryPath,
    launcherPath,
    entries: [...entriesByKey.values()].sort((left, right) => entryKey(left).localeCompare(entryKey(right))),
  };
  await atomicWrite(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function inspectPreloadInstallation({
  homeDirectory = os.homedir(),
  dataHome = defaultDataHome(homeDirectory),
} = {}) {
  const metadataPath = path.join(dataHome, PAYLOAD_DIRECTORY, PRELOAD_METADATA_FILE);
  const metadata = await loadPreloadMetadata(metadataPath);
  if (!metadata) return { installed: false, entries: [] };

  const libraryPresent = await pathExists(metadata.libraryPath);
  const launcherPresent = await pathExists(metadata.launcherPath);
  let maintenance = null;
  if (await pathExists(path.join(dataHome, PAYLOAD_DIRECTORY, "maintenance.json"))) {
    try { maintenance = await (await import("./maintenance.mjs")).inspectMaintenance({ homeDirectory, dataHome }); }
    catch { /* Invalid maintenance metadata must not hide a broken launch path. */ }
  }
  const entries = [];
  for (const entry of metadata.entries) {
    let valid = false;
    try {
      valid = sha256Text(await fs.readFile(entry.destinationPath, "utf8")) === entry.patchedSha256;
    } catch {
      valid = false;
    }
    const guard = entry.kind === "autostart" ? maintenance?.guards.find((guard) => guard.channel === entry.channel && guard.desktopPath === entry.destinationPath) : null;
    const guarded = !!guard && !!maintenance.files.find((file) => file.path === guard.path && file.valid) &&
      !!maintenance.files.find((file) => file.path === metadata.launcherPath && file.valid);
    entries.push({ ...entry, valid: valid || guarded, guarded });
  }
  return {
    installed: libraryPresent && launcherPresent && entries.length > 0 && entries.every((entry) => entry.valid),
    libraryPresent,
    launcherPresent,
    entries,
  };
}

export async function uninstallPreload({
  channels,
  homeDirectory = os.homedir(),
  dataHome = defaultDataHome(homeDirectory),
} = {}) {
  const payloadDirectory = path.join(dataHome, PAYLOAD_DIRECTORY);
  const metadataPath = path.join(payloadDirectory, PRELOAD_METADATA_FILE);
  if (await pathExists(path.join(payloadDirectory, "maintenance.json"))) {
    throw new Error("Run maintenance-uninstall before removing the preload fix");
  }
  const metadata = await loadPreloadMetadata(metadataPath);
  if (!metadata) return [];

  const selected = channels ? new Set(channels) : null;
  const removing = metadata.entries.filter((entry) => !selected || selected.has(entry.channel));
  for (const entry of removing) {
    const current = await fs.readFile(entry.destinationPath, "utf8");
    if (sha256Text(current) !== entry.patchedSha256) {
      throw new Error(`Refusing to overwrite a changed desktop entry: ${entry.destinationPath}`);
    }
    if (entry.backupPath) {
      const original = await fs.readFile(entry.backupPath, "utf8");
      if (sha256Text(original) !== entry.originalSha256) {
        throw new Error(`Desktop backup checksum mismatch: ${entry.backupPath}`);
      }
    }
  }

  for (const entry of removing) {
    if (entry.backupPath) {
      await atomicCopy(entry.backupPath, entry.destinationPath);
      await fs.unlink(entry.backupPath);
    } else {
      await fs.unlink(entry.destinationPath);
    }
  }

  const remaining = metadata.entries.filter((entry) => !removing.includes(entry));
  if (remaining.length === 0) {
    await fs.rm(payloadDirectory, { recursive: true, force: true });
  } else {
    await atomicWrite(metadataPath, `${JSON.stringify({ ...metadata, entries: remaining }, null, 2)}\n`);
  }
  return removing;
}
