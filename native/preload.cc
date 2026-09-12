// SPDX-License-Identifier: MIT

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <dlfcn.h>
#include <elf.h>
#include <link.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_set>
#include <vector>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

constexpr std::string_view kVoiceModuleName = "discord_voice.node";
constexpr std::string_view kSignalSymbol = "_ZN7discord5media9LocalUser18SignalOnSoundshareEb";
constexpr std::size_t kAbsoluteJumpSize = 14;
constexpr std::size_t kMaximumPatchSize = 48;
constexpr std::size_t kTrampolineSize = 4096;

using DlopenFn = void* (*)(const char*, int);
using SignalOnSoundshareFn = void (*)(void*, bool);

struct SymbolLocation {
  std::uintptr_t virtual_address = 0;
  std::size_t file_offset = 0;
  std::size_t size = 0;
};

struct HookState {
  std::mutex install_mutex;
  std::mutex users_mutex;
  std::unordered_set<void*> active_users;
  std::atomic<bool> installed{false};
  std::atomic<std::uint64_t> hit_count{0};
  std::atomic<std::uint64_t> blocked_count{0};
  std::atomic<bool> failed{false};
  std::string module_path;
  const std::uint8_t* target = nullptr;
  std::array<std::uint8_t, kMaximumPatchSize> patch{};
  std::size_t patch_size = 0;
  std::uintptr_t load_bias = 0;
  SignalOnSoundshareFn original = nullptr;
};

HookState g_state;

bool DebugEnabled() {
  const char* value = std::getenv("DISCORD_SOUNDSHARE_FIX_DEBUG");
  return value != nullptr && std::strcmp(value, "1") == 0;
}

bool Disabled() {
  const char* value = std::getenv("DISCORD_SOUNDSHARE_FIX_DISABLE");
  return value != nullptr && std::strcmp(value, "1") == 0;
}

void Log(bool always, const char* format, ...) {
  if (!always && !DebugEnabled()) return;
  std::fputs("[discord-soundshare-fix] ", stderr);
  va_list arguments;
  va_start(arguments, format);
  std::vfprintf(stderr, format, arguments);
  va_end(arguments);
  std::fputc('\n', stderr);
}

bool IsRangeValid(std::size_t offset, std::size_t length, std::size_t total) {
  return offset <= total && length <= total - offset;
}

template <typename T>
const T* ObjectAt(const std::vector<std::uint8_t>& bytes, std::size_t offset, std::size_t count = 1) {
  if (count > SIZE_MAX / sizeof(T) || !IsRangeValid(offset, sizeof(T) * count, bytes.size())) return nullptr;
  return reinterpret_cast<const T*>(bytes.data() + offset);
}

std::optional<std::vector<std::uint8_t>> ReadFile(const char* path, std::string* error) {
  const int descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    *error = std::string("cannot open ") + path + ": " + std::strerror(errno);
    return std::nullopt;
  }

  struct stat metadata {};
  if (fstat(descriptor, &metadata) != 0 || metadata.st_size <= 0) {
    *error = std::string("cannot stat ") + path + ": " + std::strerror(errno);
    close(descriptor);
    return std::nullopt;
  }

  std::vector<std::uint8_t> bytes(static_cast<std::size_t>(metadata.st_size));
  std::size_t completed = 0;
  while (completed < bytes.size()) {
    const ssize_t result = read(descriptor, bytes.data() + completed, bytes.size() - completed);
    if (result < 0 && errno == EINTR) continue;
    if (result <= 0) {
      *error = std::string("cannot read ") + path + ": " + (result == 0 ? "unexpected EOF" : std::strerror(errno));
      close(descriptor);
      return std::nullopt;
    }
    completed += static_cast<std::size_t>(result);
  }
  close(descriptor);
  return bytes;
}

std::optional<SymbolLocation> FindSignalSymbol(
    const std::vector<std::uint8_t>& bytes,
    std::string* error) {
  const auto* header = ObjectAt<Elf64_Ehdr>(bytes, 0);
  if (header == nullptr || std::memcmp(header->e_ident, ELFMAG, SELFMAG) != 0 ||
      header->e_ident[EI_CLASS] != ELFCLASS64 || header->e_ident[EI_DATA] != ELFDATA2LSB ||
      header->e_machine != EM_X86_64 || header->e_shentsize != sizeof(Elf64_Shdr) ||
      header->e_shnum == 0) {
    *error = "discord_voice.node is not a supported ELF64 x86_64 object";
    return std::nullopt;
  }

  const auto* sections = ObjectAt<Elf64_Shdr>(bytes, header->e_shoff, header->e_shnum);
  if (sections == nullptr) {
    *error = "ELF section table is outside discord_voice.node";
    return std::nullopt;
  }

  for (std::size_t section_index = 0; section_index < header->e_shnum; ++section_index) {
    const Elf64_Shdr& symbol_section = sections[section_index];
    if (symbol_section.sh_type != SHT_SYMTAB || symbol_section.sh_entsize != sizeof(Elf64_Sym) ||
        symbol_section.sh_link >= header->e_shnum) {
      continue;
    }

    const Elf64_Shdr& string_section = sections[symbol_section.sh_link];
    const auto* symbols = ObjectAt<Elf64_Sym>(
        bytes,
        symbol_section.sh_offset,
        symbol_section.sh_size / sizeof(Elf64_Sym));
    const auto* strings = ObjectAt<char>(bytes, string_section.sh_offset, string_section.sh_size);
    if (symbols == nullptr || strings == nullptr) continue;

    const std::size_t symbol_count = symbol_section.sh_size / sizeof(Elf64_Sym);
    for (std::size_t symbol_index = 0; symbol_index < symbol_count; ++symbol_index) {
      const Elf64_Sym& symbol = symbols[symbol_index];
      if (ELF64_ST_TYPE(symbol.st_info) != STT_FUNC || symbol.st_shndx == SHN_UNDEF ||
          symbol.st_shndx >= header->e_shnum || symbol.st_name >= string_section.sh_size) {
        continue;
      }

      const char* name = strings + symbol.st_name;
      const std::size_t remaining = string_section.sh_size - symbol.st_name;
      const void* terminator = std::memchr(name, '\0', remaining);
      if (terminator == nullptr || std::string_view(name) != kSignalSymbol) continue;

      const Elf64_Shdr& code_section = sections[symbol.st_shndx];
      if (symbol.st_value < code_section.sh_addr) break;
      const std::uint64_t relative = symbol.st_value - code_section.sh_addr;
      if (relative > code_section.sh_size) break;
      const std::uint64_t file_offset = code_section.sh_offset + relative;
      const std::size_t available = symbol.st_size == 0
          ? static_cast<std::size_t>(code_section.sh_size - relative)
          : static_cast<std::size_t>(symbol.st_size);
      if (!IsRangeValid(static_cast<std::size_t>(file_offset), available, bytes.size())) break;

      return SymbolLocation{
          .virtual_address = static_cast<std::uintptr_t>(symbol.st_value),
          .file_offset = static_cast<std::size_t>(file_offset),
          .size = available,
      };
    }
  }

  *error = "LocalUser::SignalOnSoundshare(bool) was not found in the ELF symbol table";
  return std::nullopt;
}

std::optional<std::size_t> DecodeModRm(
    const std::uint8_t* bytes,
    std::size_t available,
    bool* rip_relative) {
  if (available < 1) return std::nullopt;
  std::size_t length = 1;
  const std::uint8_t modrm = bytes[0];
  const std::uint8_t mode = modrm >> 6;
  const std::uint8_t rm = modrm & 7;

  if (mode == 3) return length;
  if (rm == 4) {
    if (available < length + 1) return std::nullopt;
    const std::uint8_t sib = bytes[length++];
    if (mode == 0 && (sib & 7) == 5) {
      if (available < length + 4) return std::nullopt;
      length += 4;
    }
  } else if (mode == 0 && rm == 5) {
    if (available < length + 4) return std::nullopt;
    *rip_relative = true;
    length += 4;
  }

  if (mode == 1) {
    if (available < length + 1) return std::nullopt;
    length += 1;
  } else if (mode == 2) {
    if (available < length + 4) return std::nullopt;
    length += 4;
  }
  return length;
}

std::optional<std::size_t> DecodeSafeInstruction(const std::uint8_t* bytes, std::size_t available) {
  if (available >= 4 && bytes[0] == 0xF3 && bytes[1] == 0x0F && bytes[2] == 0x1E && bytes[3] == 0xFA) {
    return 4;  // endbr64
  }

  std::size_t cursor = 0;
  bool address_size_override = false;
  while (cursor < available) {
    const std::uint8_t byte = bytes[cursor];
    if (byte >= 0x40 && byte <= 0x4F) {
      ++cursor;
      continue;
    }
    if (byte == 0x66 || byte == 0xF2 || byte == 0xF3 || byte == 0x64 || byte == 0x65) {
      ++cursor;
      continue;
    }
    if (byte == 0x67) {
      address_size_override = true;
      ++cursor;
      continue;
    }
    break;
  }
  if (cursor >= available || address_size_override) return std::nullopt;

  const std::uint8_t opcode = bytes[cursor++];
  if ((opcode >= 0x50 && opcode <= 0x5F) || opcode == 0x90) return cursor;
  if (opcode == 0x68) return available >= cursor + 4 ? std::optional(cursor + 4) : std::nullopt;
  if (opcode == 0x6A) return available >= cursor + 1 ? std::optional(cursor + 1) : std::nullopt;
  if (opcode >= 0xB8 && opcode <= 0xBF) {
    const bool rex_w = cursor >= 2 && (bytes[cursor - 2] & 0xF8) == 0x48 && (bytes[cursor - 2] & 0x08) != 0;
    const std::size_t immediate = rex_w ? 8 : 4;
    return available >= cursor + immediate ? std::optional(cursor + immediate) : std::nullopt;
  }

  bool has_modrm = false;
  std::size_t immediate = 0;
  switch (opcode) {
    case 0x88:
    case 0x89:
    case 0x8A:
    case 0x8B:
    case 0x8D:
    case 0x85:
    case 0x29:
    case 0x2B:
    case 0x31:
    case 0x33:
    case 0x39:
    case 0x3B:
      has_modrm = true;
      break;
    case 0x80:
    case 0x82:
    case 0x83:
    case 0xC6:
      has_modrm = true;
      immediate = 1;
      break;
    case 0x81:
    case 0xC7:
      has_modrm = true;
      immediate = 4;
      break;
    case 0x0F:
      if (cursor >= available || bytes[cursor++] != 0x1F) return std::nullopt;
      has_modrm = true;  // multi-byte nop
      break;
    default:
      return std::nullopt;
  }

  if (!has_modrm) return std::nullopt;
  bool rip_relative = false;
  const auto modrm_length = DecodeModRm(bytes + cursor, available - cursor, &rip_relative);
  if (!modrm_length || rip_relative || available < cursor + *modrm_length + immediate) return std::nullopt;
  return cursor + *modrm_length + immediate;
}

std::optional<std::size_t> FindSafePatchSize(
    const std::uint8_t* bytes,
    std::size_t available,
    std::string* error) {
  const std::size_t limit = std::min(available, kMaximumPatchSize);
  std::size_t decoded = 0;
  while (decoded < kAbsoluteJumpSize && decoded < limit) {
    const auto instruction = DecodeSafeInstruction(bytes + decoded, limit - decoded);
    if (!instruction || *instruction == 0) {
      *error = "function prologue contains an instruction that cannot be relocated safely";
      return std::nullopt;
    }
    decoded += *instruction;
  }
  if (decoded < kAbsoluteJumpSize) {
    *error = "function prologue is too short for a safe absolute jump";
    return std::nullopt;
  }
  return decoded;
}

void WriteAbsoluteJump(std::uint8_t* destination, std::uintptr_t target) {
  // jmp qword ptr [rip+0], followed by the 64-bit destination. Unlike movabs
  // rax/jmp rax, this form preserves every register from the copied prologue.
  constexpr std::array<std::uint8_t, 6> instruction = {0xFF, 0x25, 0, 0, 0, 0};
  std::memcpy(destination, instruction.data(), instruction.size());
  std::memcpy(destination + instruction.size(), &target, sizeof(target));
}

bool MakeWritable(void* address, std::size_t length, int protection, std::string* error) {
  const long page_size_result = sysconf(_SC_PAGESIZE);
  if (page_size_result <= 0) {
    *error = "sysconf(_SC_PAGESIZE) failed";
    return false;
  }
  const std::uintptr_t page_size = static_cast<std::uintptr_t>(page_size_result);
  const std::uintptr_t start = reinterpret_cast<std::uintptr_t>(address);
  const std::uintptr_t page_start = start & ~(page_size - 1);
  const std::uintptr_t page_end = (start + length + page_size - 1) & ~(page_size - 1);
  if (mprotect(reinterpret_cast<void*>(page_start), page_end - page_start, protection) != 0) {
    *error = std::string("mprotect failed: ") + std::strerror(errno);
    return false;
  }
  return true;
}

extern "C" void SignalOnSoundshareReplacement(void* local_user, bool success) {
  g_state.hit_count.fetch_add(1, std::memory_order_relaxed);

  if (local_user != nullptr) {
    std::scoped_lock lock(g_state.users_mutex);
    if (success) {
      if (!g_state.active_users.insert(local_user).second) {
        const std::uint64_t blocked = g_state.blocked_count.fetch_add(1, std::memory_order_relaxed) + 1;
        Log(false, "suppressed duplicate soundshare restart (%llu total)",
            static_cast<unsigned long long>(blocked));
        return;
      }
    } else {
      g_state.active_users.erase(local_user);
    }
  }

  if (g_state.original != nullptr) g_state.original(local_user, success);
}

bool InstallHook(const char* module_path, std::uintptr_t load_bias, std::string* error) {
  std::scoped_lock lock(g_state.install_mutex);
  if (g_state.installed.load(std::memory_order_acquire)) return true;

  const auto file = ReadFile(module_path, error);
  if (!file) return false;
  const auto symbol = FindSignalSymbol(*file, error);
  if (!symbol) return false;

  const std::size_t available = std::min(symbol->size, kMaximumPatchSize);
  const auto patch_size = FindSafePatchSize(file->data() + symbol->file_offset, available, error);
  if (!patch_size) return false;

  auto* target = reinterpret_cast<std::uint8_t*>(load_bias + symbol->virtual_address);
  if (std::memcmp(target, file->data() + symbol->file_offset, *patch_size) != 0) {
    *error = "loaded function bytes do not match discord_voice.node on disk";
    return false;
  }

  void* trampoline = mmap(
      nullptr,
      kTrampolineSize,
      PROT_READ | PROT_WRITE,
      MAP_PRIVATE | MAP_ANONYMOUS,
      -1,
      0);
  if (trampoline == MAP_FAILED) {
    *error = std::string("cannot allocate trampoline: ") + std::strerror(errno);
    return false;
  }

  auto* trampoline_bytes = static_cast<std::uint8_t*>(trampoline);
  std::memcpy(trampoline_bytes, target, *patch_size);
  WriteAbsoluteJump(
      trampoline_bytes + *patch_size,
      reinterpret_cast<std::uintptr_t>(target + *patch_size));
  if (mprotect(trampoline, kTrampolineSize, PROT_READ | PROT_EXEC) != 0) {
    *error = std::string("cannot make trampoline executable: ") + std::strerror(errno);
    munmap(trampoline, kTrampolineSize);
    return false;
  }
  __builtin___clear_cache(
      reinterpret_cast<char*>(trampoline_bytes),
      reinterpret_cast<char*>(trampoline_bytes + *patch_size + kAbsoluteJumpSize));

  g_state.original = reinterpret_cast<SignalOnSoundshareFn>(trampoline);
  if (!MakeWritable(target, *patch_size, PROT_READ | PROT_WRITE | PROT_EXEC, error)) {
    g_state.original = nullptr;
    munmap(trampoline, kTrampolineSize);
    return false;
  }
  std::array<std::uint8_t, kMaximumPatchSize> patch{};
  patch.fill(0x90);
  WriteAbsoluteJump(patch.data(), reinterpret_cast<std::uintptr_t>(&SignalOnSoundshareReplacement));
  std::memcpy(target, patch.data(), *patch_size);
  __builtin___clear_cache(reinterpret_cast<char*>(target), reinterpret_cast<char*>(target + *patch_size));
  if (!MakeWritable(target, *patch_size, PROT_READ | PROT_EXEC, error)) {
    std::memcpy(target, file->data() + symbol->file_offset, *patch_size);
    __builtin___clear_cache(reinterpret_cast<char*>(target), reinterpret_cast<char*>(target + *patch_size));
    g_state.original = nullptr;
    munmap(trampoline, kTrampolineSize);
    return false;
  }

  g_state.module_path = module_path;
  g_state.target = target;
  g_state.patch = patch;
  g_state.patch_size = *patch_size;
  g_state.load_bias = load_bias;
  g_state.installed.store(true, std::memory_order_release);
  Log(false, "active for %s (symbol 0x%llx, %zu-byte prologue)",
      module_path,
      static_cast<unsigned long long>(symbol->virtual_address),
      *patch_size);
  return true;
}

bool IsVoiceModule(const char* path) {
  if (path == nullptr) return false;
  const char* separator = std::strrchr(path, '/');
  const char* name = separator == nullptr ? path : separator + 1;
  return name == kVoiceModuleName;
}

DlopenFn ResolveDlopen() {
  static DlopenFn real_dlopen = [] {
    void* symbol = dlsym(RTLD_NEXT, "dlopen");
    DlopenFn function = nullptr;
    static_assert(sizeof(function) == sizeof(symbol));
    std::memcpy(&function, &symbol, sizeof(function));
    return function;
  }();
  return real_dlopen;
}

void TryInstallForHandle(const char* requested_path, void* handle) {
  if (handle == nullptr || Disabled()) return;

  struct link_map* map = nullptr;
  if (dlinfo(handle, RTLD_DI_LINKMAP, &map) != 0 || map == nullptr) {
    g_state.failed.store(true);
    Log(true, "cannot inspect loaded discord_voice.node: %s", dlerror());
    return;
  }
  const char* module_path = map->l_name != nullptr && map->l_name[0] != '\0' ? map->l_name : requested_path;
  std::string error;
  if (!InstallHook(module_path, static_cast<std::uintptr_t>(map->l_addr), &error)) {
    g_state.failed.store(true);
    Log(true, "patch skipped safely: %s", error.c_str());
  }
}

}  // namespace

// Read-only, versioned ABI. Never installs a hook or exposes addresses to JS.
// 0 waiting, 1 active, 2 install failed, 3 disabled, 4 hook no longer intact.
extern "C" __attribute__((visibility("default"))) int discord_soundshare_fix_status_v1(
    std::uint64_t* hits, std::uint64_t* blocked) {
  if (hits) *hits = g_state.hit_count.load(std::memory_order_relaxed);
  if (blocked) *blocked = g_state.blocked_count.load(std::memory_order_relaxed);
  if (Disabled()) return 3;
  if (!g_state.installed.load(std::memory_order_acquire)) return g_state.failed.load() ? 2 : 0;
  // Hold a loader reference while reading the code, even if another thread unloads it.
  const auto real_dlopen = ResolveDlopen();
  void* handle = real_dlopen ? real_dlopen(g_state.module_path.c_str(), RTLD_NOW | RTLD_NOLOAD) : nullptr;
  if (!handle) return 4;
  struct link_map* map = nullptr;
  const bool intact = dlinfo(handle, RTLD_DI_LINKMAP, &map) == 0 && map &&
      static_cast<std::uintptr_t>(map->l_addr) == g_state.load_bias &&
      std::memcmp(g_state.target, g_state.patch.data(), g_state.patch_size) == 0;
  dlclose(handle);
  return intact ? 1 : 4;
}

extern "C" __attribute__((visibility("default"))) void* dlopen(const char* filename, int flags) {
  const DlopenFn real_dlopen = ResolveDlopen();
  if (real_dlopen == nullptr) {
    Log(true, "cannot resolve the real dlopen");
    return nullptr;
  }
  void* handle = real_dlopen(filename, flags);
  if (handle != nullptr && IsVoiceModule(filename)) TryInstallForHandle(filename, handle);
  return handle;
}

extern "C" __attribute__((visibility("default"))) int discord_soundshare_fix_inspect(
    const char* module_path,
    std::uint64_t* symbol_offset,
    std::size_t* patch_size,
    char* error_buffer,
    std::size_t error_buffer_size) {
  std::string error;
  if (module_path == nullptr) {
    error = "module path is missing";
  } else {
    const auto file = ReadFile(module_path, &error);
    if (file) {
      const auto symbol = FindSignalSymbol(*file, &error);
      if (symbol) {
        const auto decoded = FindSafePatchSize(
            file->data() + symbol->file_offset,
            std::min(symbol->size, kMaximumPatchSize),
            &error);
        if (decoded) {
          if (symbol_offset != nullptr) *symbol_offset = symbol->virtual_address;
          if (patch_size != nullptr) *patch_size = *decoded;
          if (error_buffer != nullptr && error_buffer_size > 0) error_buffer[0] = '\0';
          return 0;
        }
      }
    }
  }

  if (error_buffer != nullptr && error_buffer_size > 0) {
    std::snprintf(error_buffer, error_buffer_size, "%s", error.c_str());
  }
  return 1;
}
