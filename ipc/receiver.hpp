#pragma once

#include "buffer.hpp"
#include <optional>

namespace knitting::ipc {

class Receiver {
 public:
  Receiver(Lane& lane, std::span<std::byte> arena);
  Receiver(const Receiver&) = delete;
  Receiver& operator=(const Receiver&) = delete;
  std::optional<IncomingBuffer> try_receive();

 private:
  friend class IncomingBuffer;
  Lane& lane_;
  std::span<std::byte> arena_;
  QueueMask retired_ = 0, borrowed_inline_ = 0;
  unsigned cursor_ = queue_slots - 1;
  void retire_slot(std::uint32_t slot) noexcept;
  void release(Storage storage, std::uint32_t index) noexcept;
};

}  // namespace knitting::ipc
