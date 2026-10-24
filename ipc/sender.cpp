// SPDX-License-Identifier: Apache-2.0
#include "sender.hpp"

#include <bit>
#include <cstring>
#include <stdexcept>

#include "detail.hpp"

namespace knitting::ipc {
Sender::Sender(Lane& lane, std::span<std::byte> arena, ArenaReclamation reclamation)
    : lane_(lane), arena_(arena), reclamation_(reclamation) {
  detail::validate_arena(arena);
}
std::optional<std::uint32_t> Sender::free_queue_slot() {
  // A stale acknowledgement can hide a newly freed slot, but cannot make an
  // outstanding slot look free. Refresh only when the cached free set is empty.
  auto free = ~((published_ ^ retired_shadow_) | reserved_inline_);
  if (!free) {
    retired_shadow_ = lane_.control.retired.bits.load(std::memory_order_acquire);
    free = ~((published_ ^ retired_shadow_) | reserved_inline_);
  }
  if (!free) {
    return std::nullopt;
  }
  return queue_slots - 1 - std::countl_zero(free);
}
void Sender::reconcile() {
  std::array<std::uint32_t, region_words> freed{};
  for (unsigned word = 0; word < region_words; ++word) {
    if (!used_[word]) {
      continue;
    }
    // The consumer's release orders its final reads before this acquire, so a
    // matching parity permits the producer to overwrite the region again.
    auto retired = lane_.control.regions_retired.bits[word].load(std::memory_order_acquire);
    freed[word] = used_[word] & ~(region_published_[word] ^ retired);
    used_[word] &= ~freed[word];
  }
  std::size_t write = 0;
  for (std::size_t read = 0; read < extent_count_; ++read) {
    auto entry = extents_[read];
    if (!(freed[entry.region >> 5] & region_bit(entry.region))) {
      extents_[write++] = entry;
    }
  }
  extent_count_ = write;
}
std::optional<OutgoingBuffer> Sender::allocate_arena(std::size_t size) {
  if (size > arena_.size()) {
    return std::nullopt;
  }
  auto capacity =
      static_cast<std::uint32_t>((size + cache_line_bytes - 1) & ~(cache_line_bytes - 1));
  std::uint32_t offset =
      extent_count_ ? extents_[extent_count_ - 1].offset + extents_[extent_count_ - 1].capacity : 0;
  std::size_t insert = extent_count_;
  // Cached occupied extents can only hide released capacity. Append without
  // remote observations while both byte capacity and a region identity remain.
  if (reclamation_ == ArenaReclamation::eager || extent_count_ == region_slots ||
      std::size_t(offset) + capacity > arena_.size()) {
    reconcile();
    if (extent_count_ == region_slots) {
      return std::nullopt;
    }
    // At pressure, reclaim holes with sorted first-fit. Removing completed
    // extents coalesces adjacent free ranges without a shared free list.
    offset = 0;
    insert = 0;
    for (; insert < extent_count_; ++insert) {
      const auto& entry = extents_[insert];
      if (entry.offset - offset >= capacity) {
        break;
      }
      offset = entry.offset + entry.capacity;
    }
    if (std::size_t(offset) + capacity > arena_.size()) {
      return std::nullopt;
    }
  }
  unsigned word = ~used_[0] ? 0 : 1;
  auto region = word * 32 + std::countr_zero(~used_[word]);
  for (std::size_t at = extent_count_; at > insert; --at) {
    extents_[at] = extents_[at - 1];
  }
  extents_[insert] = {region, offset, capacity};
  ++extent_count_;
  auto bit = region_bit(region);
  used_[word] |= bit;
  region_published_[word] ^= bit;
  lane_.control.regions_published.bits[word].store(region_published_[word],
                                                   std::memory_order_release);
  return OutgoingBuffer(this, Storage::arena, region, offset, arena_.subspan(offset, size));
}
bool Sender::commit(OutgoingBuffer& buffer, std::uint64_t id) {
  auto index = buffer.storage_ == Storage::inline_buffer
                   ? std::optional<std::uint32_t>(buffer.index_)
                   : free_queue_slot();
  if (!index) {
    return false;
  }
  auto& descriptor = lane_.slots[*index].descriptor;
  descriptor.id = id;
  descriptor.offset = buffer.offset_;
  descriptor.length = static_cast<std::uint32_t>(buffer.bytes_.size());
  descriptor.region = buffer.storage_ == Storage::arena ? buffer.index_ : 0;
  descriptor.storage = buffer.storage_;
  auto bit = queue_bit(*index);
  reserved_inline_ &= ~bit;
  published_ ^= bit;
  // Publish only after all descriptor and payload writes have completed.
  lane_.control.published.bits.store(published_, std::memory_order_release);
  return true;
}
void Sender::cancel(const OutgoingBuffer& buffer) noexcept {
  if (buffer.storage_ == Storage::inline_buffer) {
    reserved_inline_ &= ~queue_bit(buffer.index_);
    return;
  }
  // No descriptor was published for this loan. Restoring our publication parity
  // cancels it without fabricating a consumer acknowledgement. A committed loan
  // can never enter this path: commit() disowns its OutgoingBuffer handle.
  unsigned word = buffer.index_ >> 5;
  auto bit = region_bit(buffer.index_);
  used_[word] &= ~bit;
  region_published_[word] ^= bit;
  lane_.control.regions_published.bits[word].store(region_published_[word],
                                                   std::memory_order_release);
  for (std::size_t at = 0; at < extent_count_; ++at) {
    if (extents_[at].region != buffer.index_) {
      continue;
    }
    for (std::size_t next = at + 1; next < extent_count_; ++next) {
      extents_[next - 1] = extents_[next];
    }
    --extent_count_;
    break;
  }
}
bool Sender::send_arena(std::span<const std::byte> bytes, std::uint64_t id) {
  auto buffer = try_allocate(bytes.size());
  if (!buffer) {
    return false;
  }
  if (!bytes.empty()) {
    std::memcpy(buffer->bytes().data(), bytes.data(), bytes.size());
  }
  return buffer->commit(id);
}

}  // namespace knitting::ipc
