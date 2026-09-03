# Discord Linux Soundshare Fix

[![CI](https://github.com/zxsleebu/discord-linux-soundshare-fix/actions/workflows/ci.yml/badge.svg)](https://github.com/zxsleebu/discord-linux-soundshare-fix/actions/workflows/ci.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Linux x86_64](https://img.shields.io/badge/platform-Linux%20x86__64-fcc624?logo=linux&logoColor=black)](#compatibility)

Fixes Discord screen-share audio dropouts on Linux when PipeWire or PulseAudio
creates a new audio node.

On affected systems, Discord reports a fresh successful soundshare start for
every newly monitored sink input. That duplicate notification reaches
`LocalUser::SignalOnSoundshare`, which destroys and recreates the WebRTC audio
send stream. The result is a several-second gap even though capture itself is
still healthy.

This patch makes only the duplicate-success path idempotent. The first success,
all failures, and Discord's original PCM capture cadence remain untouched.

## Compatibility

| Discord build | Platform | `discord_voice.node` SHA-256 | Status |
| --- | --- | --- | --- |
| Stable 1.0.156 | Linux x86_64 | `d219e2bb…d18de8` | Supported |

The installer fails closed on unknown binaries. A Discord update cannot make it
blindly patch an unverified address.

Vencord and OpenAsar are compatible: this project patches the separately
downloaded `discord_voice` module and preserves Discord's existing JavaScript
wrapper.

## Install

### Prebuilt release

```bash
curl -LO https://github.com/zxsleebu/discord-linux-soundshare-fix/releases/latest/download/discord-linux-soundshare-fix-linux-x64.tar.gz
tar -xzf discord-linux-soundshare-fix-linux-x64.tar.gz
cd discord-linux-soundshare-fix
node ./bin/discord-soundshare-fix.mjs status
node ./bin/discord-soundshare-fix.mjs install
```

Fully quit Discord, including its tray process, and start it again.

### Build from source

Requirements: Linux x86_64, Node.js 20 or newer, Python, a C++20 compiler, and
`make`.

```bash
git clone https://github.com/zxsleebu/discord-linux-soundshare-fix.git
cd discord-linux-soundshare-fix
npm install
npm run verify
node ./bin/discord-soundshare-fix.mjs install
```

Select a particular installation when more than one Discord channel is found:

```bash
node ./bin/discord-soundshare-fix.mjs install --channel stable
node ./bin/discord-soundshare-fix.mjs install --path ~/.config/discord/app-1.0.156
```

## Status and uninstall

```bash
node ./bin/discord-soundshare-fix.mjs status
node ./bin/discord-soundshare-fix.mjs uninstall
```

The installer stores an exact backup beside Discord's `index.js`. Uninstall
restores that file and removes only the patch payload.

For runtime diagnostics, launch Discord with:

```bash
DISCORD_SOUNDSHARE_FIX_DEBUG=1 discord
```

Set `DISCORD_SOUNDSHARE_FIX_DISABLE=1` to skip the in-memory hook without
uninstalling files.

## Safety model

- The original `discord_voice.node` is never modified or redistributed.
- Discord's complete `index.js` is preserved; the installer adds one marked,
  fail-open loader block.
- The installer checks the full SHA-256 of `discord_voice.node`.
- The native module checks the target function prologue before writing memory.
- Installation uses atomic file replacement.
- Unsupported versions are reported instead of guessed.

## How it works

The verified event chain in Discord Stable 1.0.156 is:

```text
new PulseAudio sink input
  → PulseAudioController::MonitorSinkInput
  → duplicate Status::Success
  → AudioDevice::Impl::OnStart
  → LocalUser::SignalOnSoundshare(true)
  → DestroyAudioStream + CreateAudioStream
```

The N-API addon hooks `LocalUser::SignalOnSoundshare(bool)` and suppresses only
`true` calls made while soundshare is already active. This avoids changing the
ring buffer, mixer, frame size, or audio scheduling.

## Updating for a new Discord release

Open an issue with the output of:

```bash
node ./bin/discord-soundshare-fix.mjs status
```

Do not upload Discord's proprietary module publicly. A maintainer can verify the
new function layout locally, add its SHA and offset to
[`runtime/supported-builds.json`](runtime/supported-builds.json), and publish a
new release.

## Credits

Root cause analysis and the first working patch were developed collaboratively
by [sleebu](https://github.com/zxsleebu) and OpenAI Codex, using runtime logs and
reverse engineering of the locally installed Discord module.

Discord is a trademark of Discord Inc. This project is an independent,
unofficial compatibility fix and is not affiliated with Discord Inc.
