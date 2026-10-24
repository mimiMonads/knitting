// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <span>

#include "layout.hpp"

namespace knitting::ipc {

// Owns one file descriptor and mapping. Must outlive all endpoint views and
// buffer loans made from it. Moving transfers ownership without remapping.
class Mapping {
 public:
  Mapping() = default;
  ~Mapping();
  Mapping(const Mapping&) = delete;
  Mapping& operator=(const Mapping&) = delete;
  Mapping(Mapping&& other) noexcept;
  Mapping& operator=(Mapping&& other) noexcept;

  [[nodiscard]] static Mapping create(std::uint32_t arena_bytes = default_arena_bytes);
  // Duplicates an already transferred/inherited memfd; never owns the argument.
  [[nodiscard]] static Mapping attach(int fd);
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
