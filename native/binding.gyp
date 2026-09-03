{
  "targets": [
    {
      "target_name": "discord_soundshare_fix",
      "sources": ["voice_hook.cc"],
      "cflags_cc": ["-std=c++20"],
      "defines": ["NAPI_VERSION=8"]
    }
  ]
}
