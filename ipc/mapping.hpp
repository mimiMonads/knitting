#pragma once

#include "layout.hpp"
#include <span>

namespace knitting::ipc {

class Mapping {
 public:
  Mapping() = default;
  ~Mapping();
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  Mapping(Mapping&& other) noexcept;
  Mapping& operator=(Mapping&& other) noexcept;

  static Mapping create(std::uint32_t arena_bytes = 4 * 1024 * 1024);
  // Duplicates an already transferred/inherited memfd; never owns the argument.
  static Mapping attach(int fd);
  int fd() const noexcept { return fd_; }
  Lane& lane(unsigned direction) const;
  std::span<std::byte> arena(unsigned direction) const;

 private:
  int fd_ = -1;
  void* address_ = nullptr;
  std::size_t size_ = 0;
  void reset() noexcept;
};

}  // namespace knitting::ipc
