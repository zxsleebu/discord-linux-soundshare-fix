// SPDX-License-Identifier: MIT

#include <dlfcn.h>

#include <cstdio>
#include <cstring>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "usage: %s discord_voice.node\n", argv[0]);
    return 2;
  }

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

  dlclose(module);
  return 0;
}
