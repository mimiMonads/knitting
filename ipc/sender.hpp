#pragma once

#include "buffer.hpp"
#include <array>
#include <optional>

namespace knitting::ipc {

// One thread/process per endpoint. Construct once on a fresh direction; local
// allocator state is intentionally not reconstructible after endpoint failure.
class Sender {
 public:
  Sender(Lane& lane, std::span<std::byte> arena);
  Sender(const Sender&) = delete;
  Sender& operator=(const Sender&) = delete;
  std::optional<OutgoingBuffer> try_allocate(std::size_t size);
  bool try_send(std::span<const std::byte> bytes, std::uint64_t id);

 private:
  friend class OutgoingBuffer;
  struct Extent { std::uint32_t region, offset, capacity; };
  Lane& lane_;
  std::span<std::byte> arena_;
  QueueMask published_ = 0, retired_shadow_ = 0, reserved_inline_ = 0;
  std::array<std::uint32_t, 2> region_published_{}, used_{};
  std::array<Extent, region_slots> extents_{};
  std::size_t extent_count_ = 0;
  std::optional<std::uint32_t> free_queue_slot();
  void reconcile();
  bool commit(OutgoingBuffer& buffer, std::uint64_t id);
  void cancel(const OutgoingBuffer& buffer) noexcept;
};

}  // namespace knitting::ipc
