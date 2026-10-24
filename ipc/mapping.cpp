// SPDX-License-Identifier: Apache-2.0
#include "mapping.hpp"

#include <fcntl.h>
#include <linux/memfd.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <new>
#include <stdexcept>
#include <system_error>
#include <utility>

namespace knitting::ipc {
namespace {
std::size_t mapping_bytes(std::uint32_t arena) {
  return sizeof(Header) + 2 * (sizeof(Lane) + std::size_t(arena));
}
void require(bool success, const char* operation) {
  if (!success) {
    throw std::system_error(errno, std::generic_category(), operation);
  }
}
}  // namespace

void Mapping::reset() noexcept {
  if (address_) {
    munmap(address_, size_);
  }
  if (fd_ >= 0) {
    close(fd_);
  }
  address_ = nullptr;
  fd_ = -1;
  size_ = 0;
}
Mapping::~Mapping() {
  reset();
}
Mapping::Mapping(Mapping&& other) noexcept {
  *this = std::move(other);
}
Mapping& Mapping::operator=(Mapping&& other) noexcept {
  if (this != &other) {
    reset();
    fd_ = std::exchange(other.fd_, -1);
    address_ = std::exchange(other.address_, nullptr);
    size_ = std::exchange(other.size_, 0);
  }
  return *this;
}
Mapping Mapping::create(std::uint32_t arena_size) {
  if (arena_size == 0 || arena_size > max_arena_bytes || arena_size % cache_line_bytes) {
    throw std::invalid_argument("arena size must be a multiple of 64 in [64, 1 GiB]");
  }
  Mapping result;
  result.fd_ = static_cast<int>(syscall(SYS_memfd_create, "knitting-ipc", MFD_CLOEXEC));
  require(result.fd_ >= 0, "memfd_create");
  result.size_ = mapping_bytes(arena_size);
  require(ftruncate(result.fd_, static_cast<off_t>(result.size_)) == 0, "ftruncate");
  void* address = mmap(nullptr, result.size_, PROT_READ | PROT_WRITE, MAP_SHARED, result.fd_, 0);
  require(address != MAP_FAILED, "mmap");
  result.address_ = address;
  auto* header = new (address) Header{};
  header->magic = mapping_magic;
  header->arena_bytes = arena_size;
  header->mapping_bytes = result.size_;
  for (unsigned direction = 0; direction < 2; ++direction) {
    auto* lane_address =
        static_cast<std::byte*>(address) + sizeof(Header) + direction * (sizeof(Lane) + arena_size);
    new (lane_address) Lane{};
  }
  // Hand the fd to the peer only after this publication. attach() acquires it
  // before inspecting non-atomic header fields or constructing endpoint views.
  header->ready.store(1, std::memory_order_release);
  return result;
}
Mapping Mapping::attach(int fd) {
  Mapping result;
  result.fd_ = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  require(result.fd_ >= 0, "duplicate memfd");
  struct stat status{};
  require(fstat(result.fd_, &status) == 0, "fstat");
  if (status.st_size < static_cast<off_t>(sizeof(Header)) ||
      static_cast<std::uint64_t>(status.st_size) > mapping_bytes(max_arena_bytes)) {
    throw std::invalid_argument("invalid mapping length");
  }
  result.size_ = static_cast<std::size_t>(status.st_size);
  void* address = mmap(nullptr, result.size_, PROT_READ | PROT_WRITE, MAP_SHARED, result.fd_, 0);
  require(address != MAP_FAILED, "mmap attachment");
  result.address_ = address;
  const auto& header = *static_cast<const Header*>(address);
  if (header.ready.load(std::memory_order_acquire) != 1 || header.magic != mapping_magic ||
      header.version != format_version || header.arena_bytes == 0 ||
      header.queue_slot_count != queue_slots || header.arena_bytes > max_arena_bytes ||
      header.arena_bytes % cache_line_bytes || header.mapping_bytes != result.size_ ||
      mapping_bytes(header.arena_bytes) != result.size_) {
    throw std::invalid_argument("incompatible or incomplete IPC mapping");
  }
  return result;
}
Lane& Mapping::lane(unsigned direction) const {
  if (!address_ || direction > 1) {
    throw std::invalid_argument("invalid mapping direction");
  }
  const auto& header = *static_cast<const Header*>(address_);
  return *reinterpret_cast<Lane*>(static_cast<std::byte*>(address_) + sizeof(Header) +
                                  direction * (sizeof(Lane) + header.arena_bytes));
}
std::span<std::byte> Mapping::arena(unsigned direction) const {
  auto& prefix = lane(direction);
  return {reinterpret_cast<std::byte*>(&prefix) + sizeof(Lane),
          static_cast<const Header*>(address_)->arena_bytes};
}

}  // namespace knitting::ipc
