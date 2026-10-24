// SPDX-License-Identifier: Apache-2.0
#pragma once
// Shared workload, validation and timing helpers for native comparisons.
#include <sched.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "checksum.hpp"
#include "knitting_ipc.hpp"

using namespace knitting::ipc;
using Clock = std::chrono::steady_clock;
struct Request {
  std::uint64_t id, length;
};
struct Reply {
  std::uint64_t id, checksum;
};
static_assert(sizeof(Request) == 16 && sizeof(Reply) == 16);

inline void check(bool value, const char* message) {
  if (!value) {
    throw std::runtime_error(message);
  }
}
inline void pin(int cpu) {
  check(cpu >= 0 && cpu < CPU_SETSIZE, "invalid CPU");
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(cpu, &set);
  check(sched_setaffinity(0, sizeof(set), &set) == 0 && sched_getcpu() == cpu, "CPU affinity");
}
inline void relax() {
#if defined(__x86_64__) || defined(__i386__)
  __builtin_ia32_pause();
#else
  asm volatile("" ::: "memory");
#endif
}
inline double cpu_seconds() {
  timespec time{};
  check(clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &time) == 0, "CPU clock");
  return time.tv_sec + time.tv_nsec * 1e-9;
}
inline void send_all(int fd, const void* data, std::size_t size) {
  auto pointer = static_cast<const char*>(data);
  while (size) {
    auto count = send(fd, pointer, size, MSG_NOSIGNAL);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    check(count > 0, "socket send failed");
    pointer += count;
    size -= count;
  }
}
inline void receive_all(int fd, void* data, std::size_t size) {
  auto pointer = static_cast<char*>(data);
  while (size) {
    auto count = recv(fd, pointer, size, 0);
    if (count < 0 && errno == EINTR) {
      continue;
    }
    check(count > 0, "socket receive failed");
    pointer += count;
    size -= count;
  }
}
inline std::uint64_t checksum(std::span<const std::byte> bytes) {
  return full_checksum(reinterpret_cast<const unsigned char*>(bytes.data()), bytes.size());
}
inline std::uint64_t expected(std::size_t size, std::uint64_t id) {
  return (size - 1) * 91 + id % 251;
}
inline void produce(std::span<std::byte> bytes, std::uint64_t id, bool full) {
  if (full) {
    std::memset(bytes.data(), 91, bytes.size());
  }
  bytes[0] = std::byte(id % 251);
}
