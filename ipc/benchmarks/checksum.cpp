// SPDX-License-Identifier: Apache-2.0
#include "checksum.hpp"

extern "C" __attribute__((noinline)) std::uint64_t full_checksum(const unsigned char* bytes,
                                                                 std::size_t size) {
  // Reused buffers must still be read on every call, including under LTO.
  asm volatile("" ::: "memory");
  std::uint64_t sum = 0;
  for (std::size_t i = 0; i < size; ++i) {
    sum += bytes[i];
  }
  return sum;
}
