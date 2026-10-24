#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Read-only snapshot of Discord's soundshare mixing ring.

Discord mixes every captured application into one 1-second ring buffer inside
PulseAudioController. Each monitored stream has its own write counter and the
reader follows the slowest active stream, so a stream that is ahead of the
reader is heard late by exactly that distance (modulo one second).

This tool opens /proc/<pid>/mem read-only, finds the controller by its vtable
and prints every stream's distance from the reader. It never writes to the
process, never stops it and never attaches a debugger. Reading another
process's memory needs root when kernel.yama.ptrace_scope is 1:

    sudo python3 scripts/soundshare-ring-snapshot.py

With --watch it samples every 10 ms until Ctrl+C and prints only anomalies:
reader stalls, audio pushed faster than real time, streams far ahead of or
behind the reader. Press Enter to put a MARK line in the log.

    sudo python3 scripts/soundshare-ring-snapshot.py --watch | tee ring.log
"""

import argparse
import json
import mmap
import os
import re
import struct
import subprocess
import sys
import threading
import time

MODULE_NAME = "discord_voice.node"
VTABLE_SYMBOL = b"_ZTVN7discord5media10soundshare20PulseAudioControllerE"
READ_AVAILABLE_SYMBOL = b"_ZN7discord5media10soundshare20PulseAudioController13ReadAvailableEv"
READ_SYMBOL = b"_ZN7discord5media10soundshare20PulseAudioController4ReadEPhm"

# Layout observed in Discord Stable 1.0.164. Every offset is checked against
# the instruction bytes of ReadAvailable() and Read() before it is used.
RING_OFFSET = 0x286
RING_SAMPLES = 96000  # 48 kHz stereo int16, one second
READ_COUNTER = 0x2F108
MAP_BEGIN = 0x2F110
MAP_END_NODE = 0x2F118
MAP_SIZE = 0x2F120
OBJECT_SPAN = 0x2F128
SAMPLES_PER_MS = RING_SAMPLES // 1000

READ_AVAILABLE_PATTERNS = [
    bytes.fromhex("4c8bbf20f10200"),  # mov 0x2f120(%rdi),%r15   map size
    bytes.fromhex("4c8ba710f10200"),  # mov 0x2f110(%rdi),%r12   map begin
    bytes.fromhex("4c8daf18f10200"),  # lea 0x2f118(%rdi),%r13   map end node
    bytes.fromhex("418b8e08f10200"),  # mov 0x2f108(%r14),%ecx   read counter
]
READ_PATTERNS = [
    bytes.fromhex("f0440fc18708f10200"),  # lock xadd %r8d,0x2f108(%rdi)
    bytes.fromhex("69c900770100"),        # imul $96000
    bytes.fromhex("0fb78c478602"),        # movzwl 0x286(%rdi,%r8,2)
]


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


class Elf:
    def __init__(self, path):
        with open(path, "rb") as file:
            self.data = mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ)
        if self.data[:4] != b"\x7fELF" or self.data[4] != 2:
            fail(f"{path} is not an ELF64 file")
        shoff, = struct.unpack_from("<Q", self.data, 0x28)
        shentsize, shnum = struct.unpack_from("<HH", self.data, 0x3A)
        self.sections = [
            struct.unpack_from("<IIQQQQIIQQ", self.data, shoff + index * shentsize)
            for index in range(shnum)
        ]

    def symbol(self, name):
        for _, kind, _, _, offset, size, link, _, _, entsize in self.sections:
            if kind != 2 or entsize != 24:  # SHT_SYMTAB
                continue
            strtab = self.sections[link]
            start, end = strtab[4], strtab[4] + strtab[5]
            hit = self.data.find(b"\0" + name + b"\0", start, end)
            if hit < 0:
                continue
            name_offset = hit + 1 - start
            table = self.data[offset:offset + size]
            for st_name, _, _, _, value, length in struct.iter_unpack("<IBBHQQ", table):
                if st_name == name_offset:
                    return value, length
        fail(f"symbol {name.decode()} not found")

    def bytes_at(self, address, length):
        for _, _, _, section_address, offset, size, *_ in self.sections:
            if section_address <= address < section_address + size and section_address:
                start = offset + address - section_address
                return bytes(self.data[start:start + length])
        fail(f"address {address:#x} is outside every section")


FIX_LIBRARY_NAME = "libdiscord_soundshare_fix_preload.so"
# Counters inside the loaded fix library (native/preload.cc), as {name: (symbol, offset)}.
# The offsets match this repository's build; a library built from other sources
# can report wrong values.
FIX_COUNTERS = {
    "realigned": (b"_ZN12_GLOBAL__N_1L6g_ringE", 8),
    "largest_gap": (b"_ZN12_GLOBAL__N_1L6g_ringE", 16),
    "signals": (b"_ZN12_GLOBAL__N_1L7g_stateE", 144),
    "blocked": (b"_ZN12_GLOBAL__N_1L7g_stateE", 152),
    "silent_restarts": (b"_ZN12_GLOBAL__N_1L7g_stateE", 160),
}


def find_fix_counters(pid):
    """Addresses of the fix's counters in the running client, or {} without the library."""
    try:
        with open(f"/proc/{pid}/maps") as maps:
            for line in maps:
                fields = line.split(maxsplit=5)
                if len(fields) == 6 and fields[5].strip().endswith(FIX_LIBRARY_NAME) and fields[2] == "00000000":
                    base, path = int(fields[0].split("-")[0], 16), fields[5].strip()
                    break
            else:
                return {}
        elf = Elf(path)
        symbols = {}
        for _, kind, _, _, offset, size, link, _, _, entsize in elf.sections:
            if kind != 2 or entsize != 24:
                continue
            strtab = elf.sections[link]
            wanted = {}
            for symbol, _ in FIX_COUNTERS.values():
                hit = elf.data.find(b"\0" + symbol + b"\0", strtab[4], strtab[4] + strtab[5])
                if hit >= 0:
                    wanted[hit + 1 - strtab[4]] = symbol
            for st_name, _, _, _, value, _ in struct.iter_unpack("<IBBHQQ", elf.data[offset:offset + size]):
                if st_name in wanted:
                    symbols[wanted[st_name]] = base + value
    except OSError:
        return {}
    return {name: symbols[symbol] + field for name, (symbol, field) in FIX_COUNTERS.items() if symbol in symbols}


def read_fix_counters(memory, addresses):
    values = {name: memory.u64(address) for name, address in addresses.items()}
    return {name: value for name, value in values.items() if value is not None}


def find_voice_processes():
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/maps") as maps:
                for line in maps:
                    fields = line.split(maxsplit=5)
                    if len(fields) == 6 and fields[5].strip().endswith(MODULE_NAME) and fields[2] == "00000000":
                        found.append((int(entry), int(fields[0].split("-")[0], 16), fields[5].strip()))
                        break
        except OSError:
            continue
    return found


def writable_regions(pid):
    with open(f"/proc/{pid}/maps") as maps:
        for line in maps:
            fields = line.split(maxsplit=5)
            path = fields[5].strip() if len(fields) == 6 else ""
            if fields[1] != "rw-p" or (path and path != "[heap]" and not path.startswith("[anon")):
                continue
            start, end = (int(value, 16) for value in fields[0].split("-"))
            yield start, end


class Memory:
    def __init__(self, pid):
        try:
            self.fd = os.open(f"/proc/{pid}/mem", os.O_RDONLY)
        except PermissionError:
            fail("cannot read Discord's memory; run this script with sudo")

    def read(self, address, length):
        try:
            data = os.pread(self.fd, length, address)
        except OSError:
            return None
        return data if len(data) == length else None

    def u32(self, address):
        data = self.read(address, 4)
        return None if data is None else struct.unpack("<I", data)[0]

    def u64(self, address):
        data = self.read(address, 8)
        return None if data is None else struct.unpack("<Q", data)[0]


def find_controllers(memory, pid, vptr):
    needle = struct.pack("<Q", vptr)
    chunk = 32 << 20
    hits = []
    for start, end in writable_regions(pid):
        cursor = start
        while cursor < end:
            length = min(chunk, end - cursor)
            data = memory.read(cursor, length + 7 if cursor + length < end else length)
            if data is None:
                break
            index = data.find(needle)
            while index >= 0:
                if (cursor + index) % 8 == 0:
                    hits.append(cursor + index)
                index = data.find(needle, index + 1)
            cursor += length
    return hits


def walk_streams(memory, controller):
    size = memory.u64(controller + MAP_SIZE)
    node = memory.u64(controller + MAP_BEGIN)
    end_node = controller + MAP_END_NODE
    if size is None or node is None or size > 4096:
        return None
    streams = []
    for _ in range(size):
        if node in (None, 0) or node == end_node:
            return None
        container = memory.u64(node + 0x28)
        raw = memory.read(container, 0x14) if container else None
        if raw is None:
            return None
        stream, sink_input, corked, write = struct.unpack("<QIII", raw)
        streams.append((sink_input, corked, write, stream))
        right = memory.u64(node + 8)
        if right:
            node = right
            while (left := memory.u64(node)) not in (None, 0):
                node = left
        else:
            while True:
                parent = memory.u64(node + 0x10)
                if parent is None:
                    return None
                if memory.u64(parent) == node:
                    node = parent
                    break
                node = parent
    return streams if node == end_node else None


def as_user(command):
    """Run audio clients as the desktop user; root has no session bus or sockets."""
    user = os.environ.get("SUDO_USER")
    uid = os.environ.get("SUDO_UID")
    if os.geteuid() == 0 and user and uid:
        return ["sudo", "-u", user, "env", f"XDG_RUNTIME_DIR=/run/user/{uid}"] + command
    return command


def sink_input_names():
    try:
        output = subprocess.run(as_user(["pactl", "list", "sink-inputs"]),
                                capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    names, current = {}, None
    for line in output.splitlines():
        if match := re.match(r"Sink Input #(\d+)", line):
            current = int(match.group(1))
        elif current is not None and (match := re.search(r'application\.name = "(.*)"', line)):
            names.setdefault(current, match.group(1))
    return names


def signed32(value):
    return value - (1 << 32) if value & (1 << 31) else value


STALL_REPORT_MS = 100   # reader made no progress while a stream was active
STALL_DETAIL_MS = 300   # then show where the capture thread waits and what PipeWire links
BURST_REPORT_MS = 100   # reader advanced this much faster than wall time
LAG_REPORT_MS = 150     # an active stream was this far ahead of the reader
SUMMARY_SECONDS = 10
# Discord's PulseAudio thread for soundshare, and its voice engine threads.
CAPTURE_THREADS = ("pulse_app_captu", "Voice")


def thread_states(pid):
    """State and kernel wait channel; poll means no data arrived, futex a lock."""
    found = []
    try:
        tasks = os.listdir(f"/proc/{pid}/task")
    except OSError:
        return "threads unavailable"
    for tid in tasks:
        try:
            with open(f"/proc/{pid}/task/{tid}/comm") as file:
                name = file.read().strip()
            if name not in CAPTURE_THREADS:
                continue
            with open(f"/proc/{pid}/task/{tid}/stat") as file:
                state = file.read().rsplit(")", 1)[1].split()[0]
            with open(f"/proc/{pid}/task/{tid}/wchan") as file:
                wait_channel = file.read().strip() or "-"
        except OSError:
            continue
        found.append(f"{name}[{tid}] {state} {wait_channel}")
    return ", ".join(sorted(found)) or "no capture threads found"


def capture_graph():
    """Discord's capture nodes in PipeWire and the application streams linked into them."""
    try:
        output = subprocess.run(as_user(["pw-dump"]), capture_output=True, text=True, timeout=5).stdout
        dump = json.loads(output)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return ["pw-dump unavailable"]
    nodes = {item["id"]: item for item in dump if item.get("type") == "PipeWire:Interface:Node"}
    links = [item["info"] for item in dump if item.get("type") == "PipeWire:Interface:Link"]
    lines = []
    for node_id, node in nodes.items():
        if node["info"].get("props", {}).get("node.name") != "discord_capture":
            continue
        sources = []
        for link in links:
            if link["input-node-id"] != node_id:
                continue
            source = nodes.get(link["output-node-id"], {}).get("info", {})
            props = source.get("props", {})
            sources.append(f"{props.get('application.name')} {source.get('state')}, link {link['state']}"
                           f"{', corked' if props.get('pulse.corked') else ''}")
        lines.append(f"capture node {node_id} {node['info'].get('state')} <- "
                     + ("; ".join(sorted(set(sources))) or "no links"))
    return lines or ["no discord_capture nodes"]


def log(message):
    now = time.time()
    print(f"{time.strftime('%H:%M:%S', time.localtime(now))}.{int(now % 1 * 1000):03d}  {message}", flush=True)


class Names:
    def __init__(self):
        self.names = sink_input_names()
        self.refreshed = time.monotonic()

    def get(self, sink_input):
        if sink_input not in self.names and time.monotonic() - self.refreshed > 2:
            self.names.update(sink_input_names())
            self.refreshed = time.monotonic()
        return self.names.get(sink_input, "?")


class WatchState:
    def __init__(self):
        self.read = None
        self.progressed = None
        self.stall_since = None
        self.lag_peak = None  # (ms, sink input, started)
        self.reported = set()
        self.invalid_since = None
        self.streams = {}  # sink input -> (corked, write)
        self.stall_detailed = False
        self.late = {}  # sink input -> (first seen writing behind the reader, reported)
        self.reset_window()

    def reset_window(self):
        self.window_lag = 0.0
        self.window_stalls = 0
        self.window_bursts = 0
        self.window_streams = 0


def locate(memory, pid, vptr):
    log("scanning writable memory for PulseAudioController...")
    while True:
        try:
            found = [hit for hit in find_controllers(memory, pid, vptr) if walk_streams(memory, hit) is not None]
        except OSError:
            fail("the Discord process exited")
        if found:
            log("found " + ", ".join(f"{hit:#x}" for hit in found))
            return found
        time.sleep(2)


def watch(memory, pid, vptr, interval):
    marks = []
    threading.Thread(target=lambda: [marks.append(line) for line in sys.stdin], daemon=True).start()
    log(f"watching; stalls >= {STALL_REPORT_MS} ms, bursts >= {BURST_REPORT_MS} ms and "
        f"lags >= {LAG_REPORT_MS} ms are logged. Press Enter to mark a moment, Ctrl+C to stop.")
    names = Names()
    counter_addresses = find_fix_counters(pid)
    counters = read_fix_counters(memory, counter_addresses)
    log("fix counters: " + (", ".join(f"{name} {value}" for name, value in counters.items()) or "not found"))
    controllers = locate(memory, pid, vptr)
    states = {controller: WatchState() for controller in controllers}
    summary_due = time.monotonic() + SUMMARY_SECONDS
    try:
        while True:
            while marks:
                marks.pop(0)
                log("===== MARK =====")
            now = time.monotonic()
            latest = read_fix_counters(memory, counter_addresses)
            for name, label in (("blocked", "RESTART blocked while audio played"),
                                ("silent_restarts", "RESTART forwarded after silence"),
                                ("realigned", "REALIGN late stream moved to the reader")):
                if name in latest and name in counters and latest[name] > counters[name]:
                    log(f"{label} (total {latest[name]})")
            counters.update(latest)
            for controller, state in states.items():
                read = memory.u32(controller + READ_COUNTER)
                streams = walk_streams(memory, controller) if memory.u64(controller) == vptr else None
                if read is None or streams is None:
                    state.invalid_since = state.invalid_since or now
                    continue
                state.invalid_since = None
                active = [(sink_input, signed32((write - read) & 0xFFFFFFFF))
                          for sink_input, corked, write, _ in streams if not corked]
                state.window_streams = max(state.window_streams, len(streams))

                current = {sink_input: (corked, write) for sink_input, corked, write, _ in streams}
                # Harmful only while the stream keeps writing: those samples land a lap late.
                for sink_input, (corked, write) in current.items():
                    previous = state.streams.get(sink_input)
                    writing = previous is not None and previous[1] != write
                    behind = not corked and signed32((write - read) & 0xFFFFFFFF) < 0
                    if behind and writing:
                        since, reported = state.late.get(sink_input, (now, False))
                        if not reported and now - since >= 0.2:
                            log(f"LATE   #{sink_input} {names.get(sink_input)} keeps writing behind the reader; "
                                f"its audio reaches viewers about 1 s late")
                            reported = True
                        state.late[sink_input] = (since, reported)
                    elif not behind and sink_input in state.late:
                        since, reported = state.late.pop(sink_input)
                        if reported:
                            log(f"FIXED  #{sink_input} {names.get(sink_input)} back in front of the reader "
                                f"after {(now - since) * 1000:.0f} ms")
                for sink_input in sorted(current.keys() - state.streams.keys()):
                    corked, write = current[sink_input]
                    log(f"+      #{sink_input} {names.get(sink_input)} {'corked' if corked else 'active'}, "
                        f"lag {signed32((write - read) & 0xFFFFFFFF) / SAMPLES_PER_MS:.0f} ms")
                for sink_input in sorted(state.streams.keys() - current.keys()):
                    log(f"-      #{sink_input} {names.get(sink_input)} removed")
                for sink_input in sorted(current.keys() & state.streams.keys()):
                    if current[sink_input][0] != state.streams[sink_input][0]:
                        log(f"{'CORK  ' if current[sink_input][0] else 'UNCORK'} #{sink_input} {names.get(sink_input)}")
                state.streams = current

                if state.read is None:
                    state.read, state.progressed = read, now
                progress = signed32((read - state.read) & 0xFFFFFFFF)
                progress_ms = progress / SAMPLES_PER_MS
                if progress < 0:
                    state.progressed, state.stall_since = now, None  # counter moved back: new controller
                    state.stall_detailed = False
                elif progress == 0:
                    if active and state.stall_since is None:
                        state.stall_since = state.progressed
                    if (state.stall_since is not None and not state.stall_detailed and
                            (now - state.stall_since) * 1000 >= STALL_DETAIL_MS):
                        state.stall_detailed = True
                        waiting = ", ".join(f"#{sink_input} {names.get(sink_input)} {lag / SAMPLES_PER_MS:.0f} ms"
                                            for sink_input, lag in active)
                        log(f"STALL… no new audio for {STALL_DETAIL_MS} ms; active streams: {waiting}")
                        log(f"       threads: {thread_states(pid)}")
                        for line in capture_graph():
                            log(f"       {line}")
                else:
                    state.stall_detailed = False
                    waited_ms = (now - state.progressed) * 1000
                    if state.stall_since is not None and (now - state.stall_since) * 1000 >= STALL_REPORT_MS:
                        state.window_stalls += 1
                        log(f"STALL  reader waited {(now - state.stall_since) * 1000:5.0f} ms, "
                            f"then pushed {progress_ms:5.0f} ms of audio at once")
                    elif progress_ms - waited_ms >= BURST_REPORT_MS:
                        state.window_bursts += 1
                        log(f"BURST  {progress_ms:5.0f} ms of audio pushed in {waited_ms:4.0f} ms")
                    state.stall_since = None
                    state.progressed = now
                state.read = read

                ahead = [(lag, sink_input) for sink_input, lag in active if 0 <= lag < RING_SAMPLES]
                lag, leader = max(ahead) if ahead else (0, None)
                lag_ms = lag / SAMPLES_PER_MS
                state.window_lag = max(state.window_lag, lag_ms)
                if lag_ms >= LAG_REPORT_MS:
                    if state.lag_peak is None or lag_ms > state.lag_peak[0]:
                        started = state.lag_peak[2] if state.lag_peak else now
                        state.lag_peak = (lag_ms, leader, started)
                elif state.lag_peak is not None and lag_ms < LAG_REPORT_MS / 2:
                    peak, sink_input, started = state.lag_peak
                    log(f"LAG    #{sink_input} {names.get(sink_input)} was up to {peak:5.0f} ms late "
                        f"for {(now - started) * 1000:5.0f} ms")
                    state.lag_peak = None

                for sink_input, lag in active:
                    if sink_input in state.reported or 0 <= lag < RING_SAMPLES:
                        continue
                    state.reported.add(sink_input)
                    where = "behind the reader" if lag < 0 else "more than 1 s ahead"
                    log(f"ODD    #{sink_input} {names.get(sink_input)} is {abs(lag) / SAMPLES_PER_MS:5.0f} ms "
                        f"{where}; heard {(lag % RING_SAMPLES) / SAMPLES_PER_MS:4.0f} ms late")

            if any(state.invalid_since and now - state.invalid_since > 3 for state in states.values()):
                log("controller disappeared (stream restarted?)")
                controllers = locate(memory, pid, vptr)
                states = {controller: WatchState() for controller in controllers}
            if now >= summary_due:
                hook = ""
                if "realigned" in counters:
                    hook = (f", realigned {counters['realigned']}, restarts blocked {counters.get('blocked', '?')}"
                            f" / after silence {counters.get('silent_restarts', '?')}")
                for state in states.values():
                    log(f"ok     streams<={state.window_streams} max lag {state.window_lag:4.0f} ms, "
                        f"stalls {state.window_stalls}, bursts {state.window_bursts} in last {SUMMARY_SECONDS} s"
                        + hook)
                    state.reset_window()
                summary_due = now + SUMMARY_SECONDS
            time.sleep(interval)
    except KeyboardInterrupt:
        log("stopped")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pid", type=int, help="Discord process that loaded discord_voice.node")
    parser.add_argument("--count", type=int, default=10, help="number of snapshots (default 10)")
    parser.add_argument("--interval", type=float, default=0.5, help="seconds between snapshots")
    parser.add_argument("--watch", action="store_true",
                        help="run until Ctrl+C and print only anomalies; press Enter to log a mark")
    parser.add_argument("--watch-interval", type=float, default=0.01, help="seconds between watch samples")
    args = parser.parse_args()

    processes = find_voice_processes()
    if args.pid is not None:
        processes = [process for process in processes if process[0] == args.pid]
    if not processes:
        fail("no running process has discord_voice.node loaded")
    pid, base, module_path = processes[0]

    elf = Elf(module_path)
    vtable, _ = elf.symbol(VTABLE_SYMBOL)
    for symbol, patterns in ((READ_AVAILABLE_SYMBOL, READ_AVAILABLE_PATTERNS), (READ_SYMBOL, READ_PATTERNS)):
        address, length = elf.symbol(symbol)
        code = elf.bytes_at(address, length)
        if not all(pattern in code for pattern in patterns):
            fail(f"{symbol.decode()} does not match the known layout; this Discord build is unsupported")

    memory = Memory(pid)
    vptr = base + vtable + 0x10
    print(f"Discord pid {pid}, {module_path}")
    if args.watch:
        watch(memory, pid, vptr, args.watch_interval)
        return
    print("Scanning writable memory for PulseAudioController...")
    candidates = [hit for hit in find_controllers(memory, pid, vptr)
                  if walk_streams(memory, hit) is not None]
    if not candidates:
        print("No soundshare capture is running. Start a stream with sound and try again.")
        return
    names = sink_input_names()

    for snapshot in range(args.count):
        if snapshot:
            time.sleep(args.interval)
        print(f"\n[{time.strftime('%H:%M:%S')}]")
        for controller in candidates:
            read = memory.u32(controller + READ_COUNTER)
            streams = walk_streams(memory, controller)
            if read is None or streams is None:
                print(f"  controller {controller:#x}: changed during read, retrying next round")
                continue
            print(f"  controller {controller:#x}: read={read} streams={len(streams)}")
            for sink_input, corked, write, _ in streams:
                lag = signed32((write - read) & 0xFFFFFFFF)
                ring_delay = (lag % RING_SAMPLES) / SAMPLES_PER_MS
                state = "corked" if corked else "active"
                note = ""
                if not corked and lag < 0:
                    note = "  <- behind the reader, lands ~1 s late"
                elif not corked and lag >= RING_SAMPLES:
                    note = "  <- more than 1 s ahead, overlaps itself"
                name = names.get(sink_input, "?")
                print(f"    sink-input #{sink_input:<5} {name[:28]:<28} {state:<6} "
                      f"lag={lag / SAMPLES_PER_MS:9.1f} ms  heard {ring_delay:6.1f} ms late{note}")


if __name__ == "__main__":
    main()
