// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <array>
#include <bit>
#include <functional>
#include <optional>
#include <stdexcept>
#include <utility>

#include "buffer.hpp"

namespace knitting::ipc {

// One receiving thread per direction. Loans must be released on this thread
// before receiver destruction. Delivery is not FIFO; rotating priority is kept.
class Receiver {
  class RetirementBatch {
   public:
    explicit RetirementBatch(Receiver& owner) : owner_(owner) { ++owner_.batch_depth_; }
    ~RetirementBatch() {
      if (--owner_.batch_depth_ == 0) {
        owner_.flush_retirements();
        // A partially drained snapshot after an exception can be rediscovered
        // from shared parity; no cached discovery state leaks into scalar calls.
        owner_.pending_ = 0;
      }
    }
    RetirementBatch(const RetirementBatch&) = delete;
    RetirementBatch& operator=(const RetirementBatch&) = delete;

   private:
    Receiver& owner_;
  };

 public:
  Receiver(Lane& lane, std::span<std::byte> arena);
  Receiver(const Receiver&) = delete;
  Receiver& operator=(const Receiver&) = delete;
  // Refresh visibility for an individual receive. Open-set draining below
  // amortizes one acquired snapshot across several deliveries.
  [[nodiscard]] std::optional<IncomingBuffer> try_receive();

  // Drain an acquired open set, never waiting for future arrivals or a full
  // window. Callback takes a move-only loan and may retain it beyond the call.
  // Finished accesses retire together on exit, including exception unwinding.
  // Do not recursively receive/drain this endpoint from the callback.
  // Flush before blocking inside the callback on progress of the peer.
  template <class Handler>
#if defined(__GNUC__) || defined(__clang__)
  // Make the loan/callback/release chain one optimization scope. The callback
  // may retain a loan; only redundant cleanup of moved handles disappears.
  __attribute__((flatten))
#endif
  std::size_t drain(Handler&& handler) {
    RetirementBatch batch(*this);
    if (!pending_) {
      refresh_pending();
    }
    std::size_t count = 0;
    while (pending_ && count < queue_slots) {
      auto loan = take_pending();
      std::invoke(handler, std::move(loan));
      ++count;
    }
    return count;
  }

  // Expose locally retired capacity before waiting on the peer. Safe at any
  // point; a retained loan's bytes are never retired by this operation.
  void flush_retirements() noexcept;

 private:
  friend class IncomingBuffer;
  Lane& lane_;
  std::span<std::byte> arena_;
  QueueMask retired_ = 0, borrowed_inline_ = 0, pending_ = 0;
  std::array<std::uint32_t, region_words> regions_retired_{};
  unsigned cursor_ = queue_slots - 1;
  unsigned batch_depth_ = 0, dirty_regions_ = 0;
  bool dirty_queue_ = false;
  void refresh_pending();
  IncomingBuffer take_pending();
  void retire_slot(std::uint32_t slot) noexcept;
  void release(Storage storage, std::uint32_t index) noexcept;
};

// Keep slot discovery and descriptor validation visible to the caller. In the
// measured GCC build, outlining this helper added a call to every message even
// with LTO; the old monolithic receive path had been fully inlined.
#if defined(__GNUC__) || defined(__clang__)
__attribute__((always_inline))
#endif
inline IncomingBuffer Receiver::take_pending() {
  // drain() reuses this acquired snapshot until exhausted. A removed lane's
  // new generation cannot be delivered without a later acquire refresh.
  // Called only while the acquired snapshot is nonempty.
  unsigned index = cursor_;
  if (!(pending_ & queue_bit(index))) {
    auto lower = pending_ & (QueueMask(~QueueMask{0}) >> (queue_slots - 1 - cursor_));
    auto candidates = lower ? lower : pending_;
    index = queue_slots - 1 - std::countl_zero(candidates);
  }
  const auto descriptor = lane_.slots[index].descriptor;
  if (descriptor.storage == Storage::inline_buffer) {
    if (descriptor.length > inline_bytes || descriptor.offset || descriptor.region) {
      throw std::runtime_error("invalid inline descriptor");
    }
    pending_ &= ~queue_bit(index);
    cursor_ = (index + queue_slots - 1) % queue_slots;
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
  pending_ &= ~queue_bit(index);
  cursor_ = (index + queue_slots - 1) % queue_slots;
  retire_slot(index);
  return IncomingBuffer(this, Storage::arena, descriptor.region, descriptor.id,
                        arena_.subspan(descriptor.offset, descriptor.length));
}

#if defined(__GNUC__) || defined(__clang__)
__attribute__((always_inline))
#endif
inline void Receiver::retire_slot(std::uint32_t slot) noexcept {
  retired_ ^= queue_bit(slot);
  if (batch_depth_) {
    dirty_queue_ = true;
  } else {
    lane_.control.retired.bits.store(retired_, std::memory_order_release);
  }
}

#if defined(__GNUC__) || defined(__clang__)
__attribute__((always_inline))
#endif
inline void Receiver::release(Storage storage, std::uint32_t index) noexcept {
  if (storage == Storage::inline_buffer) {
    borrowed_inline_ &= ~queue_bit(index);
    retire_slot(index);
  } else {
    // Exactly one handle owns this release. A second toggle could hide a live
    // generation, which is why IncomingBuffer is move-only and release is idempotent.
    auto word = index >> 5;
    regions_retired_[word] ^= region_bit(index);
    if (batch_depth_) {
      dirty_regions_ |= 1u << word;
    } else {
      lane_.control.regions_retired.bits[word].store(regions_retired_[word],
                                                     std::memory_order_release);
    }
  }
}

}  // namespace knitting::ipc
