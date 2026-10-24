// SPDX-License-Identifier: Apache-2.0
#pragma once

#include <cstddef>
#include <cstdint>

// Both native harnesses link this function so byte-reading work is identical.
extern "C" std::uint64_t full_checksum(const unsigned char* bytes, std::size_t size);
