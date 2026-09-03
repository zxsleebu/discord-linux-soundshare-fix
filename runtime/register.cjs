"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PREFIX = "[discord-soundshare-fix]";

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest("hex");
}

module.exports = function registerDiscordSoundshareFix({ VoiceEngine, nativeModulePath }) {
  if (process.platform !== "linux" || process.arch !== "x64") return VoiceEngine;
  if (process.env.DISCORD_SOUNDSHARE_FIX_DISABLE === "1") return VoiceEngine;

  const manifest = require("./supported-builds.json");
  const moduleHash = sha256File(nativeModulePath);
  const build = manifest.builds[moduleHash];

  if (!build) {
    console.warn(`${PREFIX} unsupported discord_voice.node (${moduleHash}); patch skipped`);
    return VoiceEngine;
  }

  const nativeHook = require(path.join(__dirname, "discord_soundshare_fix.node"));
  const result = nativeHook.install({
    nativeModulePath,
    signalOnSoundshareOffset: Number.parseInt(build.signalOnSoundshareOffset, 16),
  });

  if (!result.signalOnSoundshare.verifiedPatch) {
    console.error(`${PREFIX} hook verification failed; Discord was not patched`);
    return VoiceEngine;
  }

  console.log(`${PREFIX} active for ${build.label}`);

  if (process.env.DISCORD_SOUNDSHARE_FIX_DEBUG === "1") {
    let previousBlocked = -1n;
    const timer = setInterval(() => {
      const status = nativeHook.status();
      const blocked = status.signalOnSoundshare.blockedCount;
      if (blocked !== previousBlocked) {
        console.log(`${PREFIX} suppressed duplicate restarts: ${blocked.toString()}`);
        previousBlocked = blocked;
      }
    }, 5000);
    timer.unref?.();
  }

  return VoiceEngine;
};
