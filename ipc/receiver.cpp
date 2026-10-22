#include "receiver.hpp"

#include <stdexcept>

namespace knitting::ipc {
namespace {
std::uint32_t bit_for(unsigned index) { return std::uint32_t{1} << (index & 31); }
}

Receiver::Receiver(Lane& lane, std::span<std::byte> arena) : lane_(lane), arena_(arena) {}
void Receiver::retire_slot(std::uint32_t slot) noexcept {
  retired_ ^= queue_bit(slot);
  lane_.control.retired.bits.store(retired_, std::memory_order_release);
}
std::optional<IncomingBuffer> Receiver::try_receive() {
  auto published = lane_.control.published.bits.load(std::memory_order_acquire);
  auto pending = (published ^ retired_) & ~borrowed_inline_;
  if (!pending) return std::nullopt;
  // Rotate downward like Knitting's non-stealing bitmap drain. No FIFO promise.
  unsigned index = cursor_;
  while (!(pending & queue_bit(index))) index = (index + queue_slots - 1) % queue_slots;
  cursor_ = (index + queue_slots - 1) % queue_slots;
  const auto descriptor = lane_.slots[index].descriptor;
  if (descriptor.storage == Storage::inline_buffer) {
    if (descriptor.length > inline_bytes || descriptor.offset || descriptor.region)
      throw std::runtime_error("invalid inline descriptor");
    borrowed_inline_ |= queue_bit(index);
    return IncomingBuffer(this, Storage::inline_buffer, index, descriptor.id,
                          {lane_.slots[index].bytes, descriptor.length});
  }
  if (descriptor.storage != Storage::arena || descriptor.region >= region_slots ||
      descriptor.length <= inline_bytes || descriptor.offset % cache_line_bytes ||
      std::uint64_t(descriptor.offset) + descriptor.length > arena_.size())
    throw std::runtime_error("invalid arena descriptor");
  // Copy the descriptor, then return its queue slot immediately. The payload's
  // separate retirement bit remains outstanding until the loan is released.
  retire_slot(index);
  return IncomingBuffer(this, Storage::arena, descriptor.region, descriptor.id,
                        arena_.subspan(descriptor.offset, descriptor.length));
}
void Receiver::release(Storage storage, std::uint32_t index) noexcept {
  if (storage == Storage::inline_buffer) {
    borrowed_inline_ &= ~queue_bit(index); retire_slot(index);
  } else {
    lane_.control.regions_retired.bits[index >> 5].fetch_xor(bit_for(index), std::memory_order_release);
  }
}

}  // namespace knitting::ipc
