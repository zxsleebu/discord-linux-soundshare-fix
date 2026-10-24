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
#include <chrono>
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
constexpr std::string_view kReadAvailableSymbol =
    "_ZN7discord5media10soundshare20PulseAudioController13ReadAvailableEv";
constexpr std::size_t kAbsoluteJumpSize = 14;
constexpr std::size_t kMaximumPatchSize = 48;
constexpr std::size_t kTrampolineSize = 4096;

// PulseAudioController::ReadAvailable() from Discord Stable 1.0.164. It returns
// how many mixed bytes every active stream has written past the shared read
// counter. The four controller offsets and the pa_stream_is_corked call are
// read from the zeroed operands below; every other byte, including the libc++
// map walk and the StreamContainer field offsets, must match exactly.
constexpr std::array<std::uint8_t, 0xD2> kReadAvailableTemplate = {
    0x55, 0x41, 0x57, 0x41, 0x56, 0x41, 0x55, 0x41, 0x54, 0x53, 0x50, 0x4C,
    0x8B, 0xBF, 0x00, 0x00, 0x00, 0x00, 0x4D, 0x85, 0xFF, 0x0F, 0x84, 0xA4,
    0x00, 0x00, 0x00, 0x49, 0x89, 0xFE, 0x4C, 0x8B, 0xA7, 0x00, 0x00, 0x00,
    0x00, 0x4C, 0x8D, 0xAF, 0x00, 0x00, 0x00, 0x00, 0xBB, 0x40, 0x42, 0x0F,
    0x00, 0x31, 0xED, 0x4D, 0x39, 0xEC, 0x75, 0x20, 0x4C, 0x39, 0xFD, 0xB8,
    0x00, 0x00, 0x00, 0x00, 0x0F, 0x44, 0xD8, 0xE9, 0x79, 0x00, 0x00, 0x00,
    0x0F, 0x1F, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x89, 0xC4, 0x4C,
    0x39, 0xE8, 0x74, 0xE0, 0x49, 0x8B, 0x44, 0x24, 0x28, 0x83, 0x78, 0x0C,
    0x00, 0x75, 0x0C, 0x48, 0x8B, 0x38, 0xE8, 0x00, 0x00, 0x00, 0x00, 0x85,
    0xC0, 0x74, 0x30, 0x48, 0xFF, 0xC5, 0x49, 0x8B, 0x4C, 0x24, 0x08, 0x48,
    0x85, 0xC9, 0x74, 0x14, 0x0F, 0x1F, 0x40, 0x00, 0x48, 0x89, 0xC8, 0x48,
    0x8B, 0x09, 0x48, 0x85, 0xC9, 0x75, 0xF5, 0xEB, 0xC3, 0x0F, 0x1F, 0x00,
    0x49, 0x8B, 0x44, 0x24, 0x10, 0x4C, 0x39, 0x20, 0x49, 0x89, 0xC4, 0x75,
    0xF3, 0xEB, 0xB1, 0x49, 0x8B, 0x44, 0x24, 0x28, 0x8B, 0x40, 0x10, 0x41,
    0x8B, 0x8E, 0x00, 0x00, 0x00, 0x00, 0x29, 0xC8, 0x48, 0x01, 0xC0, 0x89,
    0xD9, 0x48, 0x39, 0xC8, 0x0F, 0x43, 0xC3, 0x89, 0xC3, 0xEB, 0xB3, 0x31,
    0xDB, 0x89, 0xD8, 0x48, 0x83, 0xC4, 0x08, 0x5B, 0x41, 0x5C, 0x41, 0x5D,
    0x41, 0x5E, 0x41, 0x5F, 0x5D, 0xC3,
};
constexpr std::size_t kMapSizeOperand = 0x0E;      // mov map_size(%rdi),%r15
constexpr std::size_t kMapBeginOperand = 0x21;     // mov map_begin(%rdi),%r12
constexpr std::size_t kMapEndOperand = 0x28;       // lea map_end(%rdi),%r13
constexpr std::size_t kIsCorkedCall = 0x66;        // call pa_stream_is_corked
constexpr std::size_t kReadCounterOperand = 0xAA;  // mov read_counter(%r14),%ecx
// Fixed by the template: libc++ __tree node and Discord's StreamContainer.
constexpr std::size_t kNodeLeft = 0x00;
constexpr std::size_t kNodeRight = 0x08;
constexpr std::size_t kNodeParent = 0x10;
constexpr std::size_t kNodeValue = 0x28;
constexpr std::size_t kContainerStream = 0x00;
constexpr std::size_t kContainerCorked = 0x0C;
constexpr std::size_t kContainerWrite = 0x10;
constexpr std::uint64_t kMaximumStreams = 4096;
constexpr std::size_t kMaximumTreeDepth = 64;
// A duplicate start after this long without soundshare audio is forwarded.
constexpr std::chrono::milliseconds kSilenceBeforeRestart{500};

using DlopenFn = void* (*)(const char*, int);
using SignalOnSoundshareFn = void (*)(void*, bool);
using ReadAvailableFn = std::uint64_t (*)(void*);
using StreamIsCorkedFn = int (*)(void*);

struct SymbolLocation {
  std::uintptr_t virtual_address = 0;
  std::size_t file_offset = 0;
  std::size_t size = 0;
};

struct InlineHook {
  std::string module_path;
  const std::uint8_t* target = nullptr;
  std::array<std::uint8_t, kMaximumPatchSize> patch{};
  std::size_t patch_size = 0;
  std::uintptr_t load_bias = 0;
};

struct HookState {
  std::mutex install_mutex;
  std::mutex users_mutex;
  std::unordered_set<void*> active_users;
  std::atomic<bool> installed{false};
  std::atomic<std::uint64_t> hit_count{0};
  std::atomic<std::uint64_t> blocked_count{0};
  std::atomic<std::uint64_t> silent_restart_count{0};
  std::atomic<bool> failed{false};
  InlineHook hook;
  SignalOnSoundshareFn original = nullptr;
};

struct RingLayout {
  std::uint32_t map_size = 0;
  std::uint32_t map_begin = 0;
  std::uint32_t map_end = 0;
  std::uint32_t read_counter = 0;
  std::uintptr_t stream_is_corked = 0;  // link-time address of the called PLT entry
};

struct RingState {
  std::atomic<bool> installed{false};
  std::atomic<bool> failed{false};
  std::atomic<std::uint64_t> realigned_count{0};
  std::atomic<std::uint64_t> largest_gap{0};
  std::atomic<std::int64_t> last_audio_ns{0};  // steady clock; 0 until audio was available
  RingLayout layout;
  StreamIsCorkedFn stream_is_corked = nullptr;
  InlineHook hook;
  ReadAvailableFn original = nullptr;
};

HookState g_state;
RingState g_ring;

bool DebugEnabled() {
  const char* value = std::getenv("DISCORD_SOUNDSHARE_FIX_DEBUG");
  return value != nullptr && std::strcmp(value, "1") == 0;
}

bool Disabled() {
  const char* value = std::getenv("DISCORD_SOUNDSHARE_FIX_DISABLE");
  return value != nullptr && std::strcmp(value, "1") == 0;
}

bool RingDisabled() {
  const char* value = std::getenv("DISCORD_SOUNDSHARE_FIX_RING_DISABLE");
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

std::optional<SymbolLocation> FindFunctionSymbol(
    const std::vector<std::uint8_t>& bytes,
    std::string_view mangled_name,
    const char* description,
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
      if (terminator == nullptr || std::string_view(name) != mangled_name) continue;

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

  *error = std::string(description) + " was not found in the ELF symbol table";
  return std::nullopt;
}

bool IsExecutableAddress(const std::vector<std::uint8_t>& bytes, std::uintptr_t address) {
  const auto* header = ObjectAt<Elf64_Ehdr>(bytes, 0);
  if (header == nullptr) return false;
  const auto* sections = ObjectAt<Elf64_Shdr>(bytes, header->e_shoff, header->e_shnum);
  if (sections == nullptr) return false;
  for (std::size_t index = 0; index < header->e_shnum; ++index) {
    const Elf64_Shdr& section = sections[index];
    if ((section.sh_flags & SHF_EXECINSTR) != 0 && address >= section.sh_addr &&
        address - section.sh_addr < section.sh_size) {
      return true;
    }
  }
  return false;
}

bool IsReadAvailableOperand(std::size_t offset) {
  for (const std::size_t operand :
       {kMapSizeOperand, kMapBeginOperand, kMapEndOperand, kIsCorkedCall + 1, kReadCounterOperand}) {
    if (offset >= operand && offset < operand + sizeof(std::int32_t)) return true;
  }
  return false;
}

std::optional<RingLayout> MatchReadAvailable(
    const std::vector<std::uint8_t>& bytes,
    const SymbolLocation& symbol,
    std::string* error) {
  if (symbol.size != kReadAvailableTemplate.size()) {
    *error = "PulseAudioController::ReadAvailable() has an unknown size";
    return std::nullopt;
  }
  const std::uint8_t* code = bytes.data() + symbol.file_offset;
  for (std::size_t offset = 0; offset < kReadAvailableTemplate.size(); ++offset) {
    if (!IsReadAvailableOperand(offset) && code[offset] != kReadAvailableTemplate[offset]) {
      *error = "PulseAudioController::ReadAvailable() differs from the known build";
      return std::nullopt;
    }
  }

  const auto operand = [code](std::size_t offset) {
    std::int32_t value = 0;
    std::memcpy(&value, code + offset, sizeof(value));
    return value;
  };
  const std::int32_t map_begin = operand(kMapBeginOperand);
  const std::int32_t read_counter = operand(kReadCounterOperand);
  // libc++ std::map stores {begin node, end node, size} contiguously.
  if (map_begin <= 0 || map_begin % 8 != 0 || operand(kMapEndOperand) != map_begin + 8 ||
      operand(kMapSizeOperand) != map_begin + 16 || read_counter <= 0 || read_counter % 4 != 0) {
    *error = "PulseAudioController has an unexpected stream map layout";
    return std::nullopt;
  }

  const std::intptr_t next_instruction =
      static_cast<std::intptr_t>(symbol.virtual_address + kIsCorkedCall + 5);
  const auto stream_is_corked =
      static_cast<std::uintptr_t>(next_instruction + operand(kIsCorkedCall + 1));
  if (!IsExecutableAddress(bytes, stream_is_corked)) {
    *error = "PulseAudioController::ReadAvailable() calls outside discord_voice.node code";
    return std::nullopt;
  }

  return RingLayout{
      .map_size = static_cast<std::uint32_t>(map_begin + 16),
      .map_begin = static_cast<std::uint32_t>(map_begin),
      .map_end = static_cast<std::uint32_t>(map_begin + 8),
      .read_counter = static_cast<std::uint32_t>(read_counter),
      .stream_is_corked = stream_is_corked,
  };
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

std::int64_t SteadyNanoseconds() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}

// While nothing is played, Discord sends viewers no audio frames at all.
// Continuing the same send stream after such a gap was observed to leave their
// audio one to two seconds behind the picture. Unpatched Discord restarts the
// stream when the next node appears; during silence that drops nothing, so it
// is allowed then. Without the ring hook silence cannot be detected, and
// duplicates stay suppressed.
bool SoundshareSilent() {
  if (!g_ring.installed.load(std::memory_order_acquire)) return false;
  const std::int64_t silence = SteadyNanoseconds() - g_ring.last_audio_ns.load(std::memory_order_relaxed);
  return silence >= std::chrono::nanoseconds(kSilenceBeforeRestart).count();
}

extern "C" void SignalOnSoundshareReplacement(void* local_user, bool success) {
  g_state.hit_count.fetch_add(1, std::memory_order_relaxed);

  if (local_user != nullptr) {
    std::scoped_lock lock(g_state.users_mutex);
    if (success) {
      if (!g_state.active_users.insert(local_user).second) {
        if (!SoundshareSilent()) {
          const std::uint64_t blocked = g_state.blocked_count.fetch_add(1, std::memory_order_relaxed) + 1;
          Log(false, "suppressed duplicate soundshare restart (%llu total)",
              static_cast<unsigned long long>(blocked));
          return;
        }
        const std::uint64_t allowed = g_state.silent_restart_count.fetch_add(1, std::memory_order_relaxed) + 1;
        Log(false, "forwarded duplicate soundshare restart after silence (%llu total)",
            static_cast<unsigned long long>(allowed));
      }
    } else {
      g_state.active_users.erase(local_user);
    }
  }

  if (g_state.original != nullptr) g_state.original(local_user, success);
}

// Discord mutates the stream map and counters from its PulseAudio thread
// without a lock; read them the way its own ReadAvailable() does.
template <typename T>
T LoadShared(const std::uint8_t* address) {
  return std::atomic_ref<T>(*reinterpret_cast<T*>(const_cast<std::uint8_t*>(address)))
      .load(std::memory_order_relaxed);
}

// libc++ __tree_next_iter, bounded so a concurrently rebalanced tree cannot hang us.
std::uint8_t* NextTreeNode(std::uint8_t* node) {
  if (auto* right = LoadShared<std::uint8_t*>(node + kNodeRight)) {
    node = right;
    for (std::size_t depth = 0; depth < kMaximumTreeDepth; ++depth) {
      auto* left = LoadShared<std::uint8_t*>(node + kNodeLeft);
      if (left == nullptr) return node;
      node = left;
    }
    return nullptr;
  }
  for (std::size_t depth = 0; depth < kMaximumTreeDepth; ++depth) {
    auto* parent = LoadShared<std::uint8_t*>(node + kNodeParent);
    if (parent == nullptr) return nullptr;
    if (LoadShared<std::uint8_t*>(parent + kNodeLeft) == node) return parent;
    node = parent;
  }
  return nullptr;
}

void RecordRealignment(std::uint32_t gap) {
  const std::uint64_t count = g_ring.realigned_count.fetch_add(1, std::memory_order_relaxed) + 1;
  std::uint64_t largest = g_ring.largest_gap.load(std::memory_order_relaxed);
  while (gap > largest &&
         !g_ring.largest_gap.compare_exchange_weak(largest, gap, std::memory_order_relaxed)) {
  }
  Log(false, "moved a soundshare stream %u samples forward to the reader (%llu total)",
      gap, static_cast<unsigned long long>(count));
}

// Every stream writes into one ring at its own counter, and the reader stops at
// the slowest active stream. ReadAvailable() ignores a stream whose counter is
// already behind the reader, so its audio lands where the reader returns only
// after a full lap, about one second later, until the stream is corked again.
// Move such a stream to the reader, as Discord itself does on uncork.
void RealignStreamsBehindReader(std::uint8_t* controller) {
  const RingLayout& layout = g_ring.layout;
  const auto size = LoadShared<std::uint64_t>(controller + layout.map_size);
  if (size == 0 || size > kMaximumStreams) return;
  const std::uint32_t read = LoadShared<std::uint32_t>(controller + layout.read_counter);
  const std::uint8_t* end = controller + layout.map_end;
  auto* node = LoadShared<std::uint8_t*>(controller + layout.map_begin);

  for (std::uint64_t index = 0; index < size && node != nullptr && node != end; ++index) {
    auto* container = LoadShared<std::uint8_t*>(node + kNodeValue);
    if (container != nullptr && LoadShared<std::uint32_t>(container + kContainerCorked) == 0 &&
        g_ring.stream_is_corked(LoadShared<void*>(container + kContainerStream)) == 0) {
      std::atomic_ref<std::uint32_t> write(*reinterpret_cast<std::uint32_t*>(container + kContainerWrite));
      std::uint32_t current = write.load(std::memory_order_relaxed);
      // The PulseAudio thread advances the counter one sample at a time; give up
      // after a few races and retry on the next call instead of spinning.
      for (int attempt = 0; attempt < 8 && static_cast<std::int32_t>(current - read) < 0; ++attempt) {
        if (write.compare_exchange_weak(current, read, std::memory_order_relaxed)) {
          RecordRealignment(read - current);
          break;
        }
      }
    }
    node = NextTreeNode(node);
  }
}

extern "C" std::uint64_t ReadAvailableReplacement(void* controller) {
  if (controller != nullptr) RealignStreamsBehindReader(static_cast<std::uint8_t*>(controller));
  const std::uint64_t available = g_ring.original(controller);
  if (available != 0) g_ring.last_audio_ns.store(SteadyNanoseconds(), std::memory_order_relaxed);
  return available;
}

// Redirects |symbol| to |replacement|. |original| receives a trampoline that
// runs the relocated prologue and continues in Discord's function; it is set
// before the jump is written so the replacement never sees it unset.
template <typename Fn>
bool InstallInlineHook(
    const std::vector<std::uint8_t>& file,
    const SymbolLocation& symbol,
    const char* module_path,
    std::uintptr_t load_bias,
    Fn replacement,
    Fn* original,
    InlineHook* hook,
    std::string* error) {
  const std::size_t available = std::min(symbol.size, kMaximumPatchSize);
  const auto patch_size = FindSafePatchSize(file.data() + symbol.file_offset, available, error);
  if (!patch_size) return false;

  auto* target = reinterpret_cast<std::uint8_t*>(load_bias + symbol.virtual_address);
  if (std::memcmp(target, file.data() + symbol.file_offset, *patch_size) != 0) {
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

  *original = reinterpret_cast<Fn>(trampoline);
  if (!MakeWritable(target, *patch_size, PROT_READ | PROT_WRITE | PROT_EXEC, error)) {
    *original = nullptr;
    munmap(trampoline, kTrampolineSize);
    return false;
  }
  std::array<std::uint8_t, kMaximumPatchSize> patch{};
  patch.fill(0x90);
  WriteAbsoluteJump(patch.data(), reinterpret_cast<std::uintptr_t>(replacement));
  std::memcpy(target, patch.data(), *patch_size);
  __builtin___clear_cache(reinterpret_cast<char*>(target), reinterpret_cast<char*>(target + *patch_size));
  if (!MakeWritable(target, *patch_size, PROT_READ | PROT_EXEC, error)) {
    std::memcpy(target, file.data() + symbol.file_offset, *patch_size);
    __builtin___clear_cache(reinterpret_cast<char*>(target), reinterpret_cast<char*>(target + *patch_size));
    *original = nullptr;
    munmap(trampoline, kTrampolineSize);
    return false;
  }

  hook->module_path = module_path;
  hook->target = target;
  hook->patch = patch;
  hook->patch_size = *patch_size;
  hook->load_bias = load_bias;
  return true;
}

bool InstallSignalHook(
    const std::vector<std::uint8_t>& file,
    const char* module_path,
    std::uintptr_t load_bias,
    std::string* error) {
  const auto symbol = FindFunctionSymbol(file, kSignalSymbol, "LocalUser::SignalOnSoundshare(bool)", error);
  if (!symbol) return false;
  if (!InstallInlineHook(file, *symbol, module_path, load_bias, &SignalOnSoundshareReplacement,
                         &g_state.original, &g_state.hook, error)) {
    return false;
  }
  g_state.installed.store(true, std::memory_order_release);
  Log(false, "active for %s (symbol 0x%llx, %zu-byte prologue)",
      module_path,
      static_cast<unsigned long long>(symbol->virtual_address),
      g_state.hook.patch_size);
  return true;
}

bool InstallRingHook(
    const std::vector<std::uint8_t>& file,
    const char* module_path,
    std::uintptr_t load_bias,
    std::string* error) {
  const auto symbol = FindFunctionSymbol(
      file, kReadAvailableSymbol, "PulseAudioController::ReadAvailable()", error);
  if (!symbol) return false;
  const auto layout = MatchReadAvailable(file, *symbol, error);
  if (!layout) return false;
  // The template only describes the file; the replacement also relies on the loaded copy.
  if (std::memcmp(reinterpret_cast<const void*>(load_bias + symbol->virtual_address),
                  file.data() + symbol->file_offset, symbol->size) != 0) {
    *error = "loaded PulseAudioController::ReadAvailable() does not match discord_voice.node on disk";
    return false;
  }

  g_ring.layout = *layout;
  g_ring.stream_is_corked = reinterpret_cast<StreamIsCorkedFn>(load_bias + layout->stream_is_corked);
  if (!InstallInlineHook(file, *symbol, module_path, load_bias, &ReadAvailableReplacement,
                         &g_ring.original, &g_ring.hook, error)) {
    return false;
  }
  g_ring.installed.store(true, std::memory_order_release);
  Log(false, "late soundshare streams are realigned (symbol 0x%llx)",
      static_cast<unsigned long long>(symbol->virtual_address));
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

// Holds a loader reference while reading the code, even if another thread unloads it.
bool HookIntact(const InlineHook& hook) {
  const auto real_dlopen = ResolveDlopen();
  void* handle = real_dlopen ? real_dlopen(hook.module_path.c_str(), RTLD_NOW | RTLD_NOLOAD) : nullptr;
  if (!handle) return false;
  struct link_map* map = nullptr;
  const bool intact = dlinfo(handle, RTLD_DI_LINKMAP, &map) == 0 && map &&
      static_cast<std::uintptr_t>(map->l_addr) == hook.load_bias &&
      std::memcmp(hook.target, hook.patch.data(), hook.patch_size) == 0;
  dlclose(handle);
  return intact;
}

void TryInstallForHandle(const char* requested_path, void* handle) {
  if (handle == nullptr || Disabled()) return;

  std::scoped_lock lock(g_state.install_mutex);
  const bool want_ring = !g_ring.installed.load(std::memory_order_acquire) &&
      !g_ring.failed.load() && !RingDisabled();
  if (g_state.installed.load(std::memory_order_acquire) && !want_ring) return;

  struct link_map* map = nullptr;
  if (dlinfo(handle, RTLD_DI_LINKMAP, &map) != 0 || map == nullptr) {
    g_state.failed.store(true);
    Log(true, "cannot inspect loaded discord_voice.node: %s", dlerror());
    return;
  }
  const char* module_path = map->l_name != nullptr && map->l_name[0] != '\0' ? map->l_name : requested_path;
  const auto load_bias = static_cast<std::uintptr_t>(map->l_addr);
  std::string error;
  const auto file = ReadFile(module_path, &error);
  if (!file) {
    if (!g_state.installed.load(std::memory_order_acquire)) g_state.failed.store(true);
    if (want_ring) g_ring.failed.store(true);
    Log(true, "patch skipped safely: %s", error.c_str());
    return;
  }

  if (!g_state.installed.load(std::memory_order_acquire) &&
      !InstallSignalHook(*file, module_path, load_bias, &error)) {
    g_state.failed.store(true);
    Log(true, "patch skipped safely: %s", error.c_str());
  }
  // Independent of the restart fix: an unknown ReadAvailable() leaves it working.
  error.clear();
  if (want_ring && !InstallRingHook(*file, module_path, load_bias, &error)) {
    g_ring.failed.store(true);
    Log(true, "late-stream realignment skipped safely: %s", error.c_str());
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
  return HookIntact(g_state.hook) ? 1 : 4;
}

// Read-only: duplicate starts forwarded because no soundshare audio was read for
// kSilenceBeforeRestart.
extern "C" __attribute__((visibility("default"))) std::uint64_t discord_soundshare_fix_silent_restarts_v1() {
  return g_state.silent_restart_count.load(std::memory_order_relaxed);
}

// Read-only, versioned ABI for the late-stream realignment. |largest_gap| is in
// interleaved samples (96 per millisecond at Discord's 48 kHz stereo).
// 0 waiting, 1 active, 2 unsupported build or install failed, 3 disabled,
// 4 hook no longer intact.
extern "C" __attribute__((visibility("default"))) int discord_soundshare_fix_ring_status_v1(
    std::uint64_t* realigned, std::uint64_t* largest_gap) {
  if (realigned) *realigned = g_ring.realigned_count.load(std::memory_order_relaxed);
  if (largest_gap) *largest_gap = g_ring.largest_gap.load(std::memory_order_relaxed);
  if (Disabled() || RingDisabled()) return 3;
  if (!g_ring.installed.load(std::memory_order_acquire)) return g_ring.failed.load() ? 2 : 0;
  return HookIntact(g_ring.hook) ? 1 : 4;
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
      const auto symbol = FindFunctionSymbol(*file, kSignalSymbol, "LocalUser::SignalOnSoundshare(bool)", &error);
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

// Offline check for the late-stream realignment; 0 when the build is supported.
extern "C" __attribute__((visibility("default"))) int discord_soundshare_fix_inspect_ring(
    const char* module_path,
    char* error_buffer,
    std::size_t error_buffer_size) {
  std::string error;
  if (module_path == nullptr) {
    error = "module path is missing";
  } else if (const auto file = ReadFile(module_path, &error)) {
    const auto symbol = FindFunctionSymbol(
        *file, kReadAvailableSymbol, "PulseAudioController::ReadAvailable()", &error);
    if (symbol && MatchReadAvailable(*file, *symbol, &error) &&
        FindSafePatchSize(file->data() + symbol->file_offset,
                          std::min(symbol->size, kMaximumPatchSize), &error)) {
      if (error_buffer != nullptr && error_buffer_size > 0) error_buffer[0] = '\0';
      return 0;
    }
  }

  if (error_buffer != nullptr && error_buffer_size > 0) {
    std::snprintf(error_buffer, error_buffer_size, "%s", error.c_str());
  }
  return 1;
}
