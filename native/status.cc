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
