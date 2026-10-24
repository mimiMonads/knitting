// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <array>
#include <cstring>
#include <optional>

#include "buffer.hpp"

namespace knitting::ipc {

enum class ArenaReclamation {
  eager,        // Reclaim before allocation: compact working set.
  on_pressure,  // Append locally; reclaim on byte/identity exhaustion.
};

// One thread/process per endpoint. Construct once on a fresh direction; local
// allocator state is intentionally not reconstructible after endpoint failure.
class Sender {
 public:
  Sender(Lane& lane, std::span<std::byte> arena,
         ArenaReclamation reclamation = ArenaReclamation::eager);
  Sender(const Sender&) = delete;
  Sender& operator=(const Sender&) = delete;
  // Empty means no contiguous capacity, no region identity, or no inline slot.
  // An arena loan can succeed while the descriptor queue is full.
#if defined(__GNUC__) || defined(__clang__)
  __attribute__((always_inline))
#endif
  [[nodiscard]] inline std::optional<OutgoingBuffer> try_allocate(std::size_t size) {
    if (size > inline_bytes) {
      return allocate_arena(size);
    }
    auto index = free_queue_slot();
    if (!index) {
      return std::nullopt;
    }
    reserved_inline_ |= queue_bit(*index);
    return OutgoingBuffer(this, Storage::inline_buffer, *index, 0,
                          {lane_.slots[*index].bytes, size});
  }
  // Small copies publish directly without creating a temporary reservation.
  // Existing unpublished loans still exclude their slots from selection.
  [[nodiscard]] bool try_send(std::span<const std::byte> bytes, std::uint64_t id) {
    if (bytes.size() > inline_bytes) {
      return send_arena(bytes, id);
    }
    auto index = free_queue_slot();
    if (!index) {
      return false;
    }
    auto& slot = lane_.slots[*index];
    if (!bytes.empty()) {
      std::memcpy(slot.bytes, bytes.data(), bytes.size());
    }
    auto& descriptor = slot.descriptor;
    descriptor.id = id;
    descriptor.offset = 0;
    descriptor.length = static_cast<std::uint32_t>(bytes.size());
    descriptor.region = 0;
    descriptor.storage = Storage::inline_buffer;
    published_ ^= queue_bit(*index);
    lane_.control.published.bits.store(published_, std::memory_order_release);
    return true;
  }

 private:
  friend class OutgoingBuffer;
  struct Extent {
    std::uint32_t region, offset, capacity;
  };
  Lane& lane_;
  std::span<std::byte> arena_;
  const ArenaReclamation reclamation_;
  QueueMask published_ = 0, retired_shadow_ = 0, reserved_inline_ = 0;
  std::array<std::uint32_t, region_words> region_published_{}, used_{};
  std::array<Extent, region_slots> extents_{};
  std::size_t extent_count_ = 0;
  std::optional<std::uint32_t> free_queue_slot();
  std::optional<OutgoingBuffer> allocate_arena(std::size_t size);
  void reconcile();
  bool send_arena(std::span<const std::byte> bytes, std::uint64_t id);
  bool commit(OutgoingBuffer& buffer, std::uint64_t id);
  void cancel(const OutgoingBuffer& buffer) noexcept;
};

}  // namespace knitting::ipc
