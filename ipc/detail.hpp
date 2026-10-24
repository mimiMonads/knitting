// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <span>
#include <stdexcept>

#include "layout.hpp"

namespace knitting::ipc::detail {

// Endpoint views may also come from caller-managed mappings. Require the same
// arena geometry as Mapping so every extent can be aligned without overrun.
inline void validate_arena(std::span<std::byte> arena) {
  if (arena.empty() || arena.size() > max_arena_bytes || arena.size() % cache_line_bytes != 0 ||
      reinterpret_cast<std::uintptr_t>(arena.data()) % cache_line_bytes != 0) {
    throw std::invalid_argument("arena must be 64-byte aligned with a size in [64 B, 1 GiB]");
  }
}

}  // namespace knitting::ipc::detail
