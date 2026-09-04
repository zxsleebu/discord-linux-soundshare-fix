{
  "targets": [
    {
      "target_name": "discord_soundshare_fix",
      "sources": ["voice_hook.cc"],
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_VERSION=8"]
    },
    {
      "target_name": "discord_soundshare_fix_preload",
      "type": "shared_library",
      "sources": ["preload.cc"],
      "cflags_cc": ["-std=c++20", "-fvisibility=hidden", "-Wall", "-Wextra", "-Wpedantic"],
      "libraries": ["-ldl"],
      "ldflags": ["-Wl,-z,relro", "-Wl,-z,now"]
    },
    {
      "target_name": "discord_soundshare_fix_inspect",
      "type": "executable",
      "sources": ["inspect.cc"],
      "cflags_cc": ["-std=c++20", "-Wall", "-Wextra", "-Wpedantic"],
      "libraries": ["-ldl"],
      "ldflags": ["-Wl,-z,relro", "-Wl,-z,now"]
    }
  ]
}
