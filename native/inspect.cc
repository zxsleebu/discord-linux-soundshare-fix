// SPDX-License-Identifier: MIT

#include <dlfcn.h>

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>

using InspectFn = int (*)(const char*, std::uint64_t*, std::size_t*, char*, std::size_t);

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s libdiscord_soundshare_fix_preload.so discord_voice.node [...]\n", argv[0]);
    return 2;
  }

  void* library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (library == nullptr) {
    std::fprintf(stderr, "cannot load preload library: %s\n", dlerror());
    return 3;
  }
  void* symbol = dlsym(library, "discord_soundshare_fix_inspect");
  InspectFn inspect = nullptr;
  static_assert(sizeof(inspect) == sizeof(symbol));
  std::memcpy(&inspect, &symbol, sizeof(inspect));
  if (inspect == nullptr) {
    std::fprintf(stderr, "cannot resolve inspector: %s\n", dlerror());
    return 4;
  }

  int result = 0;
  for (int index = 2; index < argc; ++index) {
    std::uint64_t offset = 0;
    std::size_t patch_size = 0;
    char error[512] = {};
    if (inspect(argv[index], &offset, &patch_size, error, sizeof(error)) == 0) {
      std::printf("compatible\t0x%llx\t%zu\t%s\n",
          static_cast<unsigned long long>(offset), patch_size, argv[index]);
    } else {
      std::printf("unsupported\t%s\t%s\n", error, argv[index]);
      result = 1;
    }
  }
  dlclose(library);
  return result;
}
