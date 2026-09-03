import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL_VERSION = "0.1.0";
export const MARKER_START = "// discord-soundshare-fix:start";
export const MARKER_END = "// discord-soundshare-fix:end";
export const PAYLOAD_DIRECTORY = "discord-soundshare-fix";
export const BACKUP_FILE = "index.js.discord-soundshare-fix.backup";

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRuntimeDirectory = path.join(rootDirectory, "runtime");

const channelLocations = [
  { channel: "stable", configDirectory: "discord" },
  { channel: "canary", configDirectory: "discordcanary" },
  { channel: "ptb", configDirectory: "discordptb" },
];

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
