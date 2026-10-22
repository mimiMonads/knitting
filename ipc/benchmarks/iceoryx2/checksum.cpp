#include <cstddef>
#include <cstdint>
// Same full-byte checksum loop and compiler barrier as ../benchmark.cpp.
extern "C" __attribute__((noinline)) std::uint64_t full_checksum(const unsigned char* bytes, std::size_t size) {
  asm volatile("" ::: "memory");
  std::uint64_t sum = 0;
  for (std::size_t i = 0; i < size; ++i) sum += bytes[i];
  return sum;
}
