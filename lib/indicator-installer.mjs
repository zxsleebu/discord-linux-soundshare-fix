import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INDICATOR_MARKER = "// discord-soundshare-fix:indicator";
const directoryName = "discord-soundshare-indicator";
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function write(file, contents, mode = 0o644) {
  const temporary = `${file}.tmp-${randomUUID()}`;
  try { await fs.writeFile(temporary, contents, { mode }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
function paths(target) {
  const payload = path.join(target.moduleDirectory, directoryName);
  return { payload, backup: `${target.indexPath}.soundshare-indicator.backup`, manifest: path.join(payload, "installation.json") };
}
export function injectIndicator(source) {
  if (source.includes(INDICATOR_MARKER)) throw new Error("Indicator marker already exists without a verified backup");
  const declaration = /^\s*const\s+VoiceEngine\s*=\s*require\((['"])\.\/discord_voice\.node\1\);[^\S\r\n]*$/m;
  const match = declaration.exec(source);
  if (!match) throw new Error("Cannot locate VoiceEngine declaration; refusing to change Discord");
  const at = match.index + match[0].length;
  return source.slice(0, at) + `\n${INDICATOR_MARKER}\ntry { require("./${directoryName}/indicator.cjs"); }\ncatch (error) { console.warn("[discord-soundshare-fix] indicator unavailable", error.message); }\n// discord-soundshare-fix:indicator:end\n` + source.slice(at);
}
export async function installIndicator(target, { runtimeDirectory = path.join(root, "runtime"), addonPath, restoreKnownOriginal = false, expectedSourceHash, preservePayloadChanges = false } = {}) {
  const p = paths(target);
  const current = await fs.readFile(target.indexPath, "utf8");
  if (expectedSourceHash && hash(current) !== expectedSourceHash) throw new Error("Voice wrapper changed during maintenance; retry later");
  let original = current;
  if (await exists(p.manifest)) {
    const saved = JSON.parse(await fs.readFile(p.manifest, "utf8"));
    if (hash(current) !== saved.patchedHash && !(restoreKnownOriginal && hash(current) === saved.originalHash)) {
      throw new Error(`Indicator loader changed: ${target.indexPath}`);
    }
    original = await fs.readFile(p.backup, "utf8");
    if (hash(original) !== saved.originalHash) throw new Error("Indicator backup checksum mismatch");
    if (preservePayloadChanges) {
      for (const [file, expected] of [["indicator.cjs", saved.scriptHash], ["discord_soundshare_fix_status.node", saved.addonHash]]) {
        const installedFile = path.join(p.payload, file);
        if (await exists(installedFile) && hash(await fs.readFile(installedFile)) !== expected) throw new Error(`Indicator payload changed: ${file}`);
      }
    }
  } else if (await exists(p.backup)) {
    throw new Error(`Unmanaged indicator backup exists: ${p.backup}`);
  }
  const patched = injectIndicator(original);
  const bridge = addonPath ?? ((await exists(path.join(root, "dist", "discord_soundshare_fix_status.node")))
    ? path.join(root, "dist", "discord_soundshare_fix_status.node")
    : path.join(root, "native/build/Release/discord_soundshare_fix_status.node"));
  // Read every source before touching the live installation.
  const script = await fs.readFile(path.join(runtimeDirectory, "indicator.cjs"));
  const addon = await fs.readFile(bridge);
  // Recheck before writes: the updater may have replaced the wrapper during IO.
  if (hash(await fs.readFile(target.indexPath)) !== hash(current)) throw new Error("Voice wrapper changed during maintenance; retry later");
  await fs.mkdir(p.payload, { recursive: true });
  if (!(await exists(p.backup))) await fs.writeFile(p.backup, original, { flag: "wx" });
  await write(path.join(p.payload, "indicator.cjs"), script);
  await write(path.join(p.payload, "discord_soundshare_fix_status.node"), addon);
  await write(p.manifest, JSON.stringify({ originalHash: hash(original), patchedHash: hash(patched), scriptHash: hash(script), addonHash: hash(addon) }, null, 2));
  if (hash(await fs.readFile(target.indexPath)) !== hash(current)) throw new Error("Voice wrapper changed during maintenance; retry later");
  await write(target.indexPath, patched);
  return target.indexPath;
}
export async function inspectIndicator(target) {
  const p = paths(target);
  if (!(await exists(p.manifest))) return { installed: false, reason: "not installed for this Discord build" };
  try {
    const saved = JSON.parse(await fs.readFile(p.manifest, "utf8"));
    const matches = hash(await fs.readFile(target.indexPath)) === saved.patchedHash &&
      hash(await fs.readFile(p.backup)) === saved.originalHash &&
      hash(await fs.readFile(path.join(p.payload, "indicator.cjs"))) === saved.scriptHash &&
      hash(await fs.readFile(path.join(p.payload, "discord_soundshare_fix_status.node"))) === saved.addonHash;
    return { installed: matches, reason: matches ? "installed (runtime status is shown in Discord)" : "files changed" };
  } catch { return { installed: false, reason: "missing or invalid files" }; }
}
export async function uninstallIndicator(target) {
  const p = paths(target);
  if (!(await exists(p.manifest))) return false;
  const saved = JSON.parse(await fs.readFile(p.manifest, "utf8"));
  if (hash(await fs.readFile(target.indexPath)) !== saved.patchedHash) throw new Error("Indicator loader changed; refusing to overwrite it");
  const original = await fs.readFile(p.backup);
  if (hash(original) !== saved.originalHash) throw new Error("Indicator backup checksum mismatch");
  await write(target.indexPath, original);
  // Leave loaded addon/script files in place until a later reinstall; remove only bookkeeping.
  await fs.unlink(p.manifest);
  await fs.unlink(p.backup);
  return true;
}
