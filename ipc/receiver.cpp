// SPDX-License-Identifier: Apache-2.0
#include "receiver.hpp"

#include <bit>
#include <stdexcept>

#include "detail.hpp"

namespace knitting::ipc {
Receiver::Receiver(Lane& lane, std::span<std::byte> arena) : lane_(lane), arena_(arena) {
  detail::validate_arena(arena);
}
void Receiver::flush_retirements() noexcept {
  // Only this endpoint writes these words. Release publishes every final read
  // sequenced before this flush, independently for queue and payload identity.
  if (dirty_queue_) {
    lane_.control.retired.bits.store(retired_, std::memory_order_release);
    dirty_queue_ = false;
  }
  for (unsigned word = 0; word < region_words; ++word) {
    if (dirty_regions_ & (1u << word)) {
      lane_.control.regions_retired.bits[word].store(regions_retired_[word],
                                                     std::memory_order_release);
    }
  }
  dirty_regions_ = 0;
}
void Receiver::refresh_pending() {
  auto published = lane_.control.published.bits.load(std::memory_order_acquire);
  pending_ = (published ^ retired_) & ~borrowed_inline_;
}
// Keep the measured scalar receive specialization lean. The explicit drain
// uses the snapshot/bit-scan helper without adding snapshot state to this path.
std::optional<IncomingBuffer> Receiver::try_receive() {
  auto published = lane_.control.published.bits.load(std::memory_order_acquire);
  auto pending = (published ^ retired_) & ~borrowed_inline_;
  if (!pending) {
    return std::nullopt;
  }
  // Rotate downward like Knitting's non-stealing bitmap drain. No FIFO promise.
  unsigned index = cursor_;
  while (!(pending & queue_bit(index))) {
    index = (index + queue_slots - 1) % queue_slots;
  }
  cursor_ = (index + queue_slots - 1) % queue_slots;
  const auto descriptor = lane_.slots[index].descriptor;
  if (descriptor.storage == Storage::inline_buffer) {
    if (descriptor.length > inline_bytes || descriptor.offset || descriptor.region) {
      throw std::runtime_error("invalid inline descriptor");
    }
    borrowed_inline_ |= queue_bit(index);
    return IncomingBuffer(this, Storage::inline_buffer, index, descriptor.id,
                          {lane_.slots[index].bytes, descriptor.length});
  }
  if (descriptor.storage != Storage::arena || descriptor.region >= region_slots ||
      descriptor.length <= inline_bytes || descriptor.offset % cache_line_bytes ||
      std::uint64_t(descriptor.offset) + descriptor.length > arena_.size()) {
    throw std::runtime_error("invalid arena descriptor");
  }
  // Copy the descriptor, then return its queue slot immediately. The payload's
  // separate retirement bit remains outstanding until the loan is released.
  retire_slot(index);
  return IncomingBuffer(this, Storage::arena, descriptor.region, descriptor.id,
                        arena_.subspan(descriptor.offset, descriptor.length));
}

}  // namespace knitting::ipc
