#pragma once

#include "layout.hpp"
#include <span>

namespace knitting::ipc {

class Sender;
class Receiver;

// A move-only producer loan. Destruction cancels unpublished storage.
// commit() returning false retains the loan for retry; success disowns it.
class OutgoingBuffer {
 public:
  ~OutgoingBuffer();
  OutgoingBuffer(const OutgoingBuffer&) = delete;
  OutgoingBuffer& operator=(const OutgoingBuffer&) = delete;
  OutgoingBuffer(OutgoingBuffer&& other) noexcept;
  OutgoingBuffer& operator=(OutgoingBuffer&& other) noexcept;
  std::span<std::byte> bytes() const;
  bool commit(std::uint64_t id);
  void cancel() noexcept;

 private:
  friend class Sender;
  OutgoingBuffer(Sender* owner, Storage storage, std::uint32_t index,
                 std::uint32_t offset, std::span<std::byte> bytes);
  Sender* owner_;
  Storage storage_;
  std::uint32_t index_, offset_;
  std::span<std::byte> bytes_;
};

// A move-only consumer loan. Release toggles the appropriate retirement bit.
// Arena loans outlive queue-slot retirement; inline loans retain their slot.
class IncomingBuffer {
 public:
  ~IncomingBuffer();
  IncomingBuffer(const IncomingBuffer&) = delete;
  IncomingBuffer& operator=(const IncomingBuffer&) = delete;
  IncomingBuffer(IncomingBuffer&& other) noexcept;
  IncomingBuffer& operator=(IncomingBuffer&& other) noexcept;
  std::span<const std::byte> bytes() const;
  std::uint64_t id() const noexcept { return id_; }
  Storage storage() const noexcept { return storage_; }
  void release() noexcept;

 private:
  friend class Receiver;
  IncomingBuffer(Receiver* owner, Storage storage, std::uint32_t index,
                 std::uint64_t id, std::span<const std::byte> bytes);
  Receiver* owner_;
  Storage storage_;
  std::uint32_t index_;
  std::uint64_t id_;
  std::span<const std::byte> bytes_;
};

}  // namespace knitting::ipc
