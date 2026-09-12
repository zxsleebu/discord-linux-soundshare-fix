// SPDX-License-Identifier: MIT

#include <dlfcn.h>

#include <cstdio>
#include <cstring>
#include <cstdint>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: %s discord_voice.node\n", argv[0]);
    return 2;
  }

  using Status = int (*)(std::uint64_t*, std::uint64_t*);
  void* status_symbol = dlsym(RTLD_DEFAULT, "discord_soundshare_fix_status_v1");
  Status status = nullptr;
  std::memcpy(&status, &status_symbol, sizeof(status));
  std::uint64_t hits = 0, blocked = 0;
  if (!status || status(&hits, &blocked) != 0 || hits != 0 || blocked != 0) return 6;

  void* module = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (module == nullptr) {
    std::fprintf(stderr, "dlopen: %s\n", dlerror());
    return 3;
  }

  using FixtureSignal = int (*)(int);
  void* symbol = dlsym(module, "fixture_signal");
  FixtureSignal signal = nullptr;
  static_assert(sizeof(signal) == sizeof(symbol));
  std::memcpy(&signal, &symbol, sizeof(signal));
  if (signal == nullptr) {
    std::fprintf(stderr, "dlsym: %s\n", dlerror());
    return 4;
  }

  const int first = signal(1);
  const int duplicate = signal(1);
  const int stopped = signal(0);
  const int restarted = signal(1);
  if (first != 1 || duplicate != 1 || stopped != 1 || restarted != 2) {
    std::fprintf(
        stderr,
        "unexpected sequence: %d %d %d %d (expected 1 1 1 2)\n",
        first,
        duplicate,
        stopped,
        restarted);
    return 5;
  }

  if (status(&hits, &blocked) != 1 || hits != 4 || blocked != 1) return 7;
  dlclose(module);
  if (status(&hits, &blocked) != 4) return 8;
  return 0;
}
