// SPDX-License-Identifier: MIT

#include <node_api.h>

#include <array>
#include <atomic>
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

#include <sys/mman.h>
#include <unistd.h>

namespace {

// Layout verified against Discord Stable 1.0.156 on Linux x86_64.
constexpr std::uintptr_t kDefaultSignalOnSoundshareOffset = 0x3BF110;
constexpr std::size_t kSoundshareActiveOffset = 0x1F48;
constexpr std::size_t kPatchSize = 15;

constexpr std::array<std::uint8_t, kPatchSize> kExpectedPrologue = {
    0x41, 0x56, 0x53, 0x48, 0x83, 0xEC, 0x18, 0x48, 0x89, 0xFB, 0x40, 0x88, 0x74, 0x24, 0x0F,
};

using SignalOnSoundshareFn = void (*)(void* local_user, bool success);

struct HookState {
  std::mutex mutex;
  bool installed = false;
  bool verified = false;
  std::uintptr_t module_base = 0;
  std::uintptr_t target_address = 0;
  std::uintptr_t replacement_address = 0;
  void* trampoline = nullptr;
  std::array<std::uint8_t, kPatchSize> original_bytes{};
  std::atomic<std::uint64_t> hit_count{0};
  std::atomic<std::uint64_t> blocked_count{0};
};

HookState g_state;

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool Check(napi_env env, napi_status status, std::string_view operation) {
  if (status == napi_ok) return true;

  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  std::string message(operation);
  if (info != nullptr && info->error_message != nullptr) {
    message += ": ";
    message += info->error_message;
  }
  Throw(env, message);
  return false;
}

std::optional<std::string> GetString(napi_env env, napi_value object, const char* key) {
  napi_value value = nullptr;
  if (!Check(env, napi_get_named_property(env, object, key, &value), "napi_get_named_property")) {
    return std::nullopt;
  }

  std::size_t length = 0;
  if (!Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "napi_get_value_string_utf8")) {
    return std::nullopt;
  }
  std::string result(length, '\0');
  if (!Check(
          env,
          napi_get_value_string_utf8(env, value, result.data(), result.size() + 1, &length),
          "napi_get_value_string_utf8")) {
    return std::nullopt;
  }
  result.resize(length);
  return result;
}

std::optional<std::uintptr_t> GetOffset(napi_env env, napi_value object, const char* key) {
  bool present = false;
  if (!Check(env, napi_has_named_property(env, object, key, &present), "napi_has_named_property")) {
    return std::nullopt;
  }
  if (!present) return kDefaultSignalOnSoundshareOffset;

  napi_value value = nullptr;
  double number = 0;
  if (!Check(env, napi_get_named_property(env, object, key, &value), "napi_get_named_property") ||
      !Check(env, napi_get_value_double(env, value, &number), "napi_get_value_double")) {
    return std::nullopt;
  }
  if (number < 0 || number > static_cast<double>(UINTPTR_MAX)) {
    Throw(env, "signalOnSoundshareOffset is out of range");
    return std::nullopt;
  }
  return static_cast<std::uintptr_t>(number);
}

std::optional<std::uintptr_t> FindModuleBase(const std::string& module_path) {
  FILE* maps = std::fopen("/proc/self/maps", "r");
  if (maps == nullptr) return std::nullopt;

  char line[4096];
  while (std::fgets(line, sizeof(line), maps) != nullptr) {
    unsigned long long start = 0;
    unsigned long long end = 0;
    unsigned long long offset = 0;
    char permissions[5] = {};
    char path[3072] = {};
    const int fields = std::sscanf(
        line,
        "%llx-%llx %4s %llx %*s %*s %3071[^\n]",
        &start,
        &end,
        permissions,
        &offset,
        path);
    if (fields >= 4 && offset == 0 && fields == 5 && module_path == path) {
      std::fclose(maps);
      return static_cast<std::uintptr_t>(start);
    }
  }

  std::fclose(maps);
  return std::nullopt;
}

void WriteAbsoluteJump(std::uint8_t* destination, std::uintptr_t target) {
  constexpr std::array<std::uint8_t, 12> kJump = {
      0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xE0,
  };
  std::memcpy(destination, kJump.data(), kJump.size());
  std::memcpy(destination + 2, &target, sizeof(target));
}

bool BuildTrampoline(std::string* error) {
  void* mapping = mmap(nullptr, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (mapping == MAP_FAILED) {
    *error = std::string("mmap failed: ") + std::strerror(errno);
    return false;
  }

  auto* bytes = static_cast<std::uint8_t*>(mapping);
  std::memcpy(bytes, g_state.original_bytes.data(), g_state.original_bytes.size());
  WriteAbsoluteJump(bytes + kPatchSize, g_state.target_address + kPatchSize);
  if (mprotect(mapping, 4096, PROT_READ | PROT_EXEC) != 0) {
    *error = std::string("mprotect trampoline failed: ") + std::strerror(errno);
    munmap(mapping, 4096);
    return false;
  }
  __builtin___clear_cache(reinterpret_cast<char*>(bytes), reinterpret_cast<char*>(bytes + kPatchSize + 12));
  g_state.trampoline = mapping;
  return true;
}

bool InstallJump(std::string* error) {
  const long page_size = sysconf(_SC_PAGESIZE);
  if (page_size <= 0) {
    *error = "sysconf(_SC_PAGESIZE) failed";
    return false;
  }

  auto* target = reinterpret_cast<std::uint8_t*>(g_state.target_address);
  const auto mask = static_cast<std::uintptr_t>(page_size - 1);
  void* page = reinterpret_cast<void*>(g_state.target_address & ~mask);
  if (mprotect(page, static_cast<std::size_t>(page_size), PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
    *error = std::string("mprotect target failed: ") + std::strerror(errno);
    return false;
  }

  std::array<std::uint8_t, kPatchSize> patch{};
  patch.fill(0x90);
  WriteAbsoluteJump(patch.data(), g_state.replacement_address);
  std::memcpy(target, patch.data(), patch.size());
  __builtin___clear_cache(reinterpret_cast<char*>(target), reinterpret_cast<char*>(target + patch.size()));

  if (mprotect(page, static_cast<std::size_t>(page_size), PROT_READ | PROT_EXEC) != 0) {
    *error = std::string("mprotect restore failed: ") + std::strerror(errno);
    return false;
  }
  return true;
}

bool VerifyJump() {
  if (g_state.target_address == 0 || g_state.replacement_address == 0) return false;
  const auto* target = reinterpret_cast<const std::uint8_t*>(g_state.target_address);
  if (target[0] != 0x48 || target[1] != 0xB8 || target[10] != 0xFF || target[11] != 0xE0) return false;

  std::uintptr_t replacement = 0;
  std::memcpy(&replacement, target + 2, sizeof(replacement));
  return replacement == g_state.replacement_address;
}

extern "C" void SignalOnSoundshareReplacement(void* local_user, bool success) {
  g_state.hit_count.fetch_add(1, std::memory_order_relaxed);

  // PulseAudioController sends Success for every newly monitored sink input.
  // Discord normally recreates its WebRTC AudioSendStream for every one of
  // those duplicate notifications. Preserve the first success and every
  // failure, but make subsequent success notifications idempotent.
  if (success && local_user != nullptr) {
    const auto* active = reinterpret_cast<const std::uint8_t*>(local_user) + kSoundshareActiveOffset;
    if (__atomic_load_n(active, __ATOMIC_ACQUIRE) != 0) {
      g_state.blocked_count.fetch_add(1, std::memory_order_relaxed);
      return;
    }
  }

  const auto original = reinterpret_cast<SignalOnSoundshareFn>(g_state.trampoline);
  if (original != nullptr) original(local_user, success);
}

napi_value MakeResult(napi_env env) {
  napi_value result = nullptr;
  napi_value hook = nullptr;
  Check(env, napi_create_object(env, &result), "napi_create_object");
  Check(env, napi_create_object(env, &hook), "napi_create_object");

  auto set_bool = [&](const char* key, bool data) {
    napi_value value = nullptr;
    Check(env, napi_get_boolean(env, data, &value), "napi_get_boolean");
    Check(env, napi_set_named_property(env, hook, key, value), "napi_set_named_property");
  };
  auto set_bigint = [&](const char* key, std::uint64_t data) {
    napi_value value = nullptr;
    Check(env, napi_create_bigint_uint64(env, data, &value), "napi_create_bigint_uint64");
    Check(env, napi_set_named_property(env, hook, key, value), "napi_set_named_property");
  };

  set_bool("installed", g_state.installed);
  set_bool("verifiedPatch", g_state.verified);
  set_bigint("targetAddress", g_state.target_address);
  set_bigint("replacementAddress", g_state.replacement_address);
  set_bigint("hitCount", g_state.hit_count.load(std::memory_order_relaxed));
  set_bigint("blockedCount", g_state.blocked_count.load(std::memory_order_relaxed));

  napi_value module_base = nullptr;
  Check(env, napi_create_bigint_uint64(env, g_state.module_base, &module_base), "napi_create_bigint_uint64");
  Check(env, napi_set_named_property(env, result, "moduleBase", module_base), "napi_set_named_property");
  Check(env, napi_set_named_property(env, result, "signalOnSoundshare", hook), "napi_set_named_property");
  return result;
}

napi_value Install(napi_env env, napi_callback_info info) {
  std::size_t argc = 1;
  napi_value argv[1] = {};
  if (!Check(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "napi_get_cb_info")) return nullptr;
  if (argc != 1) {
    Throw(env, "install requires one options object");
    return nullptr;
  }

  const auto module_path = GetString(env, argv[0], "nativeModulePath");
  const auto offset = GetOffset(env, argv[0], "signalOnSoundshareOffset");
  bool exception_pending = false;
  napi_is_exception_pending(env, &exception_pending);
  if (exception_pending || !module_path || !offset) return nullptr;

  std::scoped_lock lock(g_state.mutex);
  if (!g_state.installed) {
    const auto module_base = FindModuleBase(*module_path);
    if (!module_base) {
      Throw(env, "Could not locate discord_voice.node in /proc/self/maps");
      return nullptr;
    }

    g_state.module_base = *module_base;
    g_state.target_address = *module_base + *offset;
    g_state.replacement_address = reinterpret_cast<std::uintptr_t>(&SignalOnSoundshareReplacement);
    if (std::memcmp(
            reinterpret_cast<const void*>(g_state.target_address),
            kExpectedPrologue.data(),
            kExpectedPrologue.size()) != 0) {
      Throw(env, "SignalOnSoundshare prologue does not match a supported Discord build");
      return nullptr;
    }

    std::memcpy(
        g_state.original_bytes.data(),
        reinterpret_cast<const void*>(g_state.target_address),
        g_state.original_bytes.size());
    std::string error;
    if (!BuildTrampoline(&error) || !InstallJump(&error)) {
      Throw(env, error);
      return nullptr;
    }

    g_state.verified = VerifyJump();
    if (!g_state.verified) {
      Throw(env, "SignalOnSoundshare jump verification failed");
      return nullptr;
    }
    g_state.installed = true;
  } else {
    g_state.verified = VerifyJump();
  }

  return MakeResult(env);
}

napi_value Status(napi_env env, napi_callback_info info) {
  (void)info;
  std::scoped_lock lock(g_state.mutex);
  g_state.verified = VerifyJump();
  return MakeResult(env);
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"install", nullptr, Install, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (!Check(
          env,
          napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties),
          "napi_define_properties")) {
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
