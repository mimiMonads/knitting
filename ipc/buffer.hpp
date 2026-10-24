// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <span>
#include <stdexcept>
#include <utility>

#include "layout.hpp"

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
  // The returned span is valid only while this handle owns the reservation.
  [[nodiscard]] std::span<std::byte> bytes() const;
  [[nodiscard]] bool commit(std::uint64_t id) {
    if (!owner_) {
      throw std::logic_error("producer buffer is no longer owned");
    }
    if (!commit_owned(id)) {
      return false;
    }
    owner_ = nullptr;
    return true;
  }
  void cancel() noexcept {
    if (owner_) {
      cancel_owned();
      // Keep disowning visible to callers so moved/released temporaries need
      // no later cleanup call, including when the owner helper is outlined.
      owner_ = nullptr;
    }
  }

 private:
  friend class Sender;
  void cancel_owned() noexcept;
  bool commit_owned(std::uint64_t id);
  OutgoingBuffer(Sender* owner, Storage storage, std::uint32_t index, std::uint32_t offset,
                 std::span<std::byte> bytes);
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
  // The returned span is invalid after release, including destructor release.
  [[nodiscard]] std::span<const std::byte> bytes() const;
  std::uint64_t id() const noexcept { return id_; }
  Storage storage() const noexcept { return storage_; }
#if defined(__GNUC__) || defined(__clang__)
  // Inline the release chain when its definitions are visible (also under
  // LTO); a drain otherwise retains calls for already-disowned temporaries.
  __attribute__((flatten))
#endif
  void release() noexcept {
    if (owner_) {
      release_owned();
      owner_ = nullptr;
    }
  }

 private:
  friend class Receiver;
  void release_owned() noexcept;
  IncomingBuffer(Receiver* owner, Storage storage, std::uint32_t index, std::uint64_t id,
                 std::span<const std::byte> bytes);
  Receiver* owner_;
  Storage storage_;
  std::uint32_t index_;
  std::uint64_t id_;
  std::span<const std::byte> bytes_;
};

inline OutgoingBuffer::OutgoingBuffer(Sender* owner, Storage storage, std::uint32_t index,
                                      std::uint32_t offset, std::span<std::byte> bytes)
    : owner_(owner), storage_(storage), index_(index), offset_(offset), bytes_(bytes) {
}
inline OutgoingBuffer::~OutgoingBuffer() {
  cancel();
}
inline OutgoingBuffer::OutgoingBuffer(OutgoingBuffer&& other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)),
      storage_(other.storage_),
      index_(other.index_),
      offset_(other.offset_),
      bytes_(other.bytes_) {
}
inline OutgoingBuffer& OutgoingBuffer::operator=(OutgoingBuffer&& other) noexcept {
  if (this != &other) {
    cancel();
    owner_ = std::exchange(other.owner_, nullptr);
    storage_ = other.storage_;
    index_ = other.index_;
    offset_ = other.offset_;
    bytes_ = other.bytes_;
  }
  return *this;
}
inline std::span<std::byte> OutgoingBuffer::bytes() const {
  if (!owner_) {
    throw std::logic_error("producer buffer has been committed or cancelled");
  }
  return bytes_;
}
inline IncomingBuffer::IncomingBuffer(Receiver* owner, Storage storage, std::uint32_t index,
                                      std::uint64_t id, std::span<const std::byte> bytes)
    : owner_(owner), storage_(storage), index_(index), id_(id), bytes_(bytes) {
}
inline IncomingBuffer::~IncomingBuffer() {
  release();
}
inline IncomingBuffer::IncomingBuffer(IncomingBuffer&& other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)),
      storage_(other.storage_),
      index_(other.index_),
      id_(other.id_),
      bytes_(other.bytes_) {
}
inline IncomingBuffer& IncomingBuffer::operator=(IncomingBuffer&& other) noexcept {
  if (this != &other) {
    release();
    owner_ = std::exchange(other.owner_, nullptr);
    storage_ = other.storage_;
    index_ = other.index_;
    id_ = other.id_;
    bytes_ = other.bytes_;
  }
  return *this;
}
inline std::span<const std::byte> IncomingBuffer::bytes() const {
  if (!owner_) {
    throw std::logic_error("consumer buffer has been released");
  }
  return bytes_;
}

}  // namespace knitting::ipc
