#!/bin/sh
set -eu

project_directory=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT INT TERM

c++ -std=c++20 -O0 -fPIC -shared \
  "$project_directory/test/fixtures/voice_module.cc" \
  -o "$temporary_directory/discord_voice.node"
c++ -std=c++20 -O2 \
  "$project_directory/test/fixtures/preload_loader.cc" \
  -ldl \
  -o "$temporary_directory/preload-loader"

preload_library="$project_directory/native/build/Release/discord_soundshare_fix_preload.so"
inspector="$project_directory/native/build/Release/discord_soundshare_fix_inspect"
test -f "$preload_library"
test -x "$inspector"
"$inspector" "$preload_library" "$temporary_directory/discord_voice.node" | grep -q '^compatible'
LD_PRELOAD="$preload_library" "$temporary_directory/preload-loader" "$temporary_directory/discord_voice.node"
