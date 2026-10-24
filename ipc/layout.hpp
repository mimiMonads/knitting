// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <atomic>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <type_traits>

namespace knitting::ipc {

#if !defined(__linux__)
#error "Knitting buffer IPC requires Linux."
#endif

inline constexpr std::size_t cache_line_bytes = 64;
inline constexpr std::size_t inline_bytes = 512;
inline constexpr std::uint32_t default_arena_bytes = 4 * 1024 * 1024;
inline constexpr std::uint32_t max_arena_bytes = 1024 * 1024 * 1024;
inline constexpr std::uint64_t mapping_magic = 0x314350494e544e4bULL;
#ifndef KNITTING_IPC_QUEUE_SLOTS
#define KNITTING_IPC_QUEUE_SLOTS 32
#endif
inline constexpr std::size_t queue_slots = KNITTING_IPC_QUEUE_SLOTS;
static_assert(queue_slots == 32 || queue_slots == 64);
using QueueMask = std::conditional_t<queue_slots == 64, std::uint64_t, std::uint32_t>;
inline constexpr QueueMask queue_bit(unsigned index) {
  return QueueMask{1} << index;
}
inline constexpr std::size_t region_slots = 64;
inline constexpr std::size_t region_words = region_slots / 32;
inline constexpr std::uint32_t region_bit(unsigned index) {
  return std::uint32_t{1} << (index & 31);
}
inline constexpr std::uint32_t format_version = 2;

// Linux shared-memory ABI. All offsets are relative to the lane's arena.
// One process owns publication; its peer owns retirement. Equality means free.
struct alignas(cache_line_bytes) QueueWord {
  // Native-width atomics: C++ must not alias overlapping 32/64-bit atomics.
  std::atomic<QueueMask> bits{0};
};
struct alignas(cache_line_bytes) RegionWords {
  std::atomic<std::uint32_t> bits[region_words]{};
};
struct Controls {
  QueueWord published;
  QueueWord retired;
  RegionWords regions_published;
  RegionWords regions_retired;
};
enum class Storage : std::uint32_t { inline_buffer = 0, arena = 1 };
struct alignas(cache_line_bytes) Descriptor {
  std::uint64_t id = 0;
  std::uint32_t offset = 0;
  std::uint32_t length = 0;
  std::uint32_t region = 0;
  Storage storage = Storage::inline_buffer;
  std::byte reserved[40]{};
};
struct alignas(cache_line_bytes) Slot {
  std::byte bytes[inline_bytes]{};
  Descriptor descriptor;
};
struct Lane {
  Controls control;
  Slot slots[queue_slots];
  // Arena bytes immediately follow this fixed prefix in the mapping.
};
struct alignas(cache_line_bytes) Header {
  std::uint64_t magic = 0;
  std::uint32_t version = format_version;
  std::uint32_t arena_bytes = 0;
  std::uint64_t mapping_bytes = 0;
  std::atomic<std::uint32_t> ready{0};
  std::uint32_t queue_slot_count = queue_slots;
  std::byte reserved[32]{};
};
static_assert(std::atomic<std::uint32_t>::is_always_lock_free);
static_assert(std::atomic<QueueMask>::is_always_lock_free);
static_assert(sizeof(void*) == 8, "The mapping ABI requires a 64-bit process.");
static_assert(std::endian::native == std::endian::little, "The mapping ABI is little-endian.");
static_assert(sizeof(std::atomic<std::uint32_t>) == 4);
static_assert(sizeof(std::atomic<QueueMask>) == sizeof(QueueMask));
static_assert(std::is_standard_layout_v<Header> && std::is_standard_layout_v<Lane>);
static_assert(std::is_standard_layout_v<Descriptor> && std::is_standard_layout_v<Controls>);
static_assert(alignof(Header) == cache_line_bytes && alignof(Lane) == cache_line_bytes);
static_assert(sizeof(QueueWord) == 64 && sizeof(RegionWords) == 64);
static_assert(sizeof(Controls) == 256 && sizeof(Descriptor) == 64);
static_assert(sizeof(Slot) == 576 && sizeof(Header) == 64);
static_assert(offsetof(Controls, retired) == 64);
static_assert(offsetof(Controls, regions_published) == 128);
static_assert(offsetof(Controls, regions_retired) == 192);
static_assert(offsetof(Slot, descriptor) == 512);
static_assert(sizeof(Lane) == 256 + queue_slots * 576);
static_assert(offsetof(Lane, slots) == 256);
static_assert(offsetof(Descriptor, id) == 0 && offsetof(Descriptor, offset) == 8);
static_assert(offsetof(Descriptor, length) == 12 && offsetof(Descriptor, region) == 16);
static_assert(offsetof(Descriptor, storage) == 20);
static_assert(offsetof(Header, version) == 8 && offsetof(Header, arena_bytes) == 12);
static_assert(offsetof(Header, mapping_bytes) == 16 && offsetof(Header, ready) == 24);
static_assert(offsetof(Header, queue_slot_count) == 28);

}  // namespace knitting::ipc
