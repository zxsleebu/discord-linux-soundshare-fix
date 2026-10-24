// SPDX-License-Identifier: MIT

#include <dlfcn.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <vector>

namespace {

using Status = int (*)(std::uint64_t*, std::uint64_t*);

template <typename Fn>
Fn Resolve(void* handle, const char* name) {
  void* symbol = dlsym(handle, name);
  Fn function = nullptr;
  static_assert(sizeof(function) == sizeof(symbol));
  std::memcpy(&function, &symbol, sizeof(function));
  return function;
}

// The PulseAudioController fields ReadAvailable() reads in Discord 1.0.164.
constexpr std::size_t kReadCounter = 0x2F108;
constexpr std::size_t kMapBegin = 0x2F110;
constexpr std::size_t kMapEnd = 0x2F118;
constexpr std::size_t kMapSize = 0x2F120;
constexpr std::size_t kControllerSize = 0x2F128;

struct Container {
  void* stream;
  std::uint32_t sink_input;
  std::uint32_t corked;
  std::uint32_t write;
  std::uint32_t padding;
};

struct Node {
  Node* left;
  Node* right;
  Node* parent;
  std::uint64_t black;
  void* key;
  Container* value;
};

template <typename T>
void Store(std::uint8_t* address, T value) {
  std::memcpy(address, &value, sizeof(value));
}

int CheckRingRealignment(void* module, Status ring_status, bool disabled) {
  using ReadAvailable = std::uint64_t (*)(void*);
  const auto read_available = Resolve<ReadAvailable>(module, "fixture_read_available");
  if (read_available == nullptr) return 10;

  std::vector<std::uint64_t> storage(kControllerSize / sizeof(std::uint64_t) + 1);
  auto* controller = reinterpret_cast<std::uint8_t*>(storage.data());
  constexpr std::uint32_t read = 100000;
  Container ahead{reinterpret_cast<void*>(0xA0), 1, 0, read + 2880, 0};
  Container behind{reinterpret_cast<void*>(0xB0), 2, 0, read - 1440, 0};
  Container corked{reinterpret_cast<void*>(0xC0), 3, 1, read - 960, 0};
  Container client_corked{reinterpret_cast<void*>(0xC0C0), 4, 0, read - 480, 0};

  // In order: ahead, behind (root), corked, client_corked.
  auto* end = reinterpret_cast<Node*>(controller + kMapEnd);
  Node root{nullptr, nullptr, end, 1, behind.stream, &behind};
  Node first{nullptr, nullptr, &root, 1, ahead.stream, &ahead};
  Node third{nullptr, nullptr, &root, 0, corked.stream, &corked};
  Node fourth{nullptr, nullptr, &third, 0, client_corked.stream, &client_corked};
  root.left = &first;
  root.right = &third;
  third.right = &fourth;
  Store(controller + kReadCounter, read);
  Store(controller + kMapBegin, &first);
  Store(controller + kMapEnd, &root);
  Store(controller + kMapSize, std::uint64_t{4});

  std::uint64_t realigned = 0, largest_gap = 0;
  const std::uint64_t available = read_available(controller);
  if (disabled) {
    // Discord ignores the stream behind the reader and reads the one ahead.
    if (available != 5760 || behind.write != read - 1440) return 11;
    if (ring_status(&realigned, &largest_gap) != 3 || realigned != 0) return 12;
    return 0;
  }

  if (available != 0 || behind.write != read || ahead.write != read + 2880) return 13;
  if (corked.write != read - 960 || client_corked.write != read - 480) return 14;
  if (ring_status(&realigned, &largest_gap) != 1 || realigned != 1 || largest_gap != 1440) return 15;

  behind.write = read + 960;
  if (read_available(controller) != 1920) return 16;
  if (ring_status(&realigned, &largest_gap) != 1 || realigned != 1) return 17;
  return 0;
}

}  // namespace

int main(int argc, char** argv) {
  const bool ring_disabled = argc == 3 && std::strcmp(argv[2], "ring-disabled") == 0;
  if (argc != 2 && !ring_disabled) {
    std::fprintf(stderr, "usage: %s discord_voice.node [ring-disabled]\n", argv[0]);
    return 2;
  }

  const auto status = Resolve<Status>(RTLD_DEFAULT, "discord_soundshare_fix_status_v1");
  std::uint64_t hits = 0, blocked = 0;
  if (!status || status(&hits, &blocked) != 0 || hits != 0 || blocked != 0) return 6;
  const auto ring_status = Resolve<Status>(RTLD_DEFAULT, "discord_soundshare_fix_ring_status_v1");
  std::uint64_t realigned = 0, largest_gap = 0;
  if (!ring_status || ring_status(&realigned, &largest_gap) != (ring_disabled ? 3 : 0)) return 9;

  void* module = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
  if (module == nullptr) {
    std::fprintf(stderr, "dlopen: %s\n", dlerror());
    return 3;
  }

  using FixtureSignal = int (*)(int);
  const auto signal = Resolve<FixtureSignal>(module, "fixture_signal");
  if (signal == nullptr) {
    std::fprintf(stderr, "dlsym: %s\n", dlerror());
    return 4;
  }

  // Also the last audio the ring hook saw: duplicates right after it stay suppressed.
  if (const int failure = CheckRingRealignment(module, ring_status, ring_disabled)) return failure;

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

  // After half a second without audio a duplicate reaches Discord again, unless
  // the ring hook that detects silence is disabled.
  using SilentRestarts = std::uint64_t (*)();
  const auto silent_restarts = Resolve<SilentRestarts>(RTLD_DEFAULT, "discord_soundshare_fix_silent_restarts_v1");
  if (silent_restarts == nullptr || silent_restarts() != 0) return 19;
  usleep(600 * 1000);
  if (signal(1) != (ring_disabled ? 2 : 3)) return 20;
  if (status(&hits, &blocked) != 1 || hits != 5 || blocked != (ring_disabled ? 2u : 1u)) return 21;
  if (silent_restarts() != (ring_disabled ? 0u : 1u)) return 22;
  dlclose(module);
  if (status(&hits, &blocked) != 4) return 8;
  if (ring_status(&realigned, &largest_gap) != (ring_disabled ? 3 : 4)) return 18;
  return 0;
}
