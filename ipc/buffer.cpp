#include "buffer.hpp"
#include "sender.hpp"
#include "receiver.hpp"

#include <stdexcept>
#include <utility>

namespace knitting::ipc {

OutgoingBuffer::OutgoingBuffer(Sender* owner, Storage storage, std::uint32_t index,
                               std::uint32_t offset, std::span<std::byte> bytes)
    : owner_(owner), storage_(storage), index_(index), offset_(offset), bytes_(bytes) {}
OutgoingBuffer::~OutgoingBuffer() { cancel(); }
OutgoingBuffer::OutgoingBuffer(OutgoingBuffer&& other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)), storage_(other.storage_),
      index_(other.index_), offset_(other.offset_), bytes_(other.bytes_) {}
OutgoingBuffer& OutgoingBuffer::operator=(OutgoingBuffer&& other) noexcept {
  if (this != &other) {
    cancel(); owner_ = std::exchange(other.owner_, nullptr); storage_ = other.storage_;
    index_ = other.index_; offset_ = other.offset_; bytes_ = other.bytes_;
  }
  return *this;
}
std::span<std::byte> OutgoingBuffer::bytes() const {
  if (!owner_) throw std::logic_error("producer buffer has been committed or cancelled");
  return bytes_;
}
bool OutgoingBuffer::commit(std::uint64_t id) {
  if (!owner_) throw std::logic_error("producer buffer is no longer owned");
  if (!owner_->commit(*this, id)) return false;
  owner_ = nullptr; return true;
}
void OutgoingBuffer::cancel() noexcept {
  if (owner_) { owner_->cancel(*this); owner_ = nullptr; }
}

IncomingBuffer::IncomingBuffer(Receiver* owner, Storage storage, std::uint32_t index,
                               std::uint64_t id, std::span<const std::byte> bytes)
    : owner_(owner), storage_(storage), index_(index), id_(id), bytes_(bytes) {}
IncomingBuffer::~IncomingBuffer() { release(); }
IncomingBuffer::IncomingBuffer(IncomingBuffer&& other) noexcept
    : owner_(std::exchange(other.owner_, nullptr)), storage_(other.storage_),
      index_(other.index_), id_(other.id_), bytes_(other.bytes_) {}
IncomingBuffer& IncomingBuffer::operator=(IncomingBuffer&& other) noexcept {
  if (this != &other) {
    release(); owner_ = std::exchange(other.owner_, nullptr); storage_ = other.storage_;
    index_ = other.index_; id_ = other.id_; bytes_ = other.bytes_;
  }
  return *this;
}
std::span<const std::byte> IncomingBuffer::bytes() const {
  if (!owner_) throw std::logic_error("consumer buffer has been released");
  return bytes_;
}
void IncomingBuffer::release() noexcept {
  if (owner_) { owner_->release(storage_, index_); owner_ = nullptr; }
}

}  // namespace knitting::ipc
