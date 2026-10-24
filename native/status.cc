// SPDX-License-Identifier: MIT
#include <node_api.h>
#include <dlfcn.h>
#include <cstdint>
#include <cstring>

namespace {
napi_value ReadStatus(napi_env env, napi_callback_info) {
  using Status = int (*)(std::uint64_t*, std::uint64_t*);
  void* symbol = dlsym(RTLD_DEFAULT, "discord_soundshare_fix_status_v1");
  Status status = nullptr;
  static_assert(sizeof(status) == sizeof(symbol));
  std::memcpy(&status, &symbol, sizeof(status));
  std::uint64_t hits = 0, blocked = 0;
  const int state = status ? status(&hits, &blocked)
      : (dlsym(RTLD_DEFAULT, "discord_soundshare_fix_inspect") ? -2 : -1);
  napi_value result, value;
  if (napi_create_object(env, &result) != napi_ok) return nullptr;
  if (napi_create_int32(env, state, &value) != napi_ok ||
      napi_set_named_property(env, result, "state", value) != napi_ok) return nullptr;
  if (napi_create_double(env, static_cast<double>(hits), &value) != napi_ok ||
      napi_set_named_property(env, result, "hits", value) != napi_ok) return nullptr;
  if (napi_create_double(env, static_cast<double>(blocked), &value) != napi_ok ||
      napi_set_named_property(env, result, "blocked", value) != napi_ok) return nullptr;

  // Absent in libraries built before restarts were allowed after silence.
  using SilentRestarts = std::uint64_t (*)();
  void* silent_symbol = dlsym(RTLD_DEFAULT, "discord_soundshare_fix_silent_restarts_v1");
  if (silent_symbol != nullptr) {
    SilentRestarts silent_restarts = nullptr;
    std::memcpy(&silent_restarts, &silent_symbol, sizeof(silent_restarts));
    if (napi_create_double(env, static_cast<double>(silent_restarts()), &value) != napi_ok ||
        napi_set_named_property(env, result, "silentRestarts", value) != napi_ok) return nullptr;
  }

  // Absent in libraries built before the late-stream realignment.
  void* ring_symbol = dlsym(RTLD_DEFAULT, "discord_soundshare_fix_ring_status_v1");
  if (ring_symbol == nullptr) return result;
  Status ring_status = nullptr;
  std::memcpy(&ring_status, &ring_symbol, sizeof(ring_status));
  std::uint64_t realigned = 0, largest_gap = 0;
  const int ring_state = ring_status(&realigned, &largest_gap);
  if (napi_create_int32(env, ring_state, &value) != napi_ok ||
      napi_set_named_property(env, result, "ringState", value) != napi_ok) return nullptr;
  if (napi_create_double(env, static_cast<double>(realigned), &value) != napi_ok ||
      napi_set_named_property(env, result, "realigned", value) != napi_ok) return nullptr;
  if (napi_create_double(env, static_cast<double>(largest_gap), &value) != napi_ok ||
      napi_set_named_property(env, result, "largestGap", value) != napi_ok) return nullptr;
  return result;
}
napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "readStatus", NAPI_AUTO_LENGTH, ReadStatus, nullptr, &function) != napi_ok ||
      napi_set_named_property(env, exports, "readStatus", function) != napi_ok) return nullptr;
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
