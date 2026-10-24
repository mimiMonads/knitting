// SPDX-License-Identifier: Apache-2.0
#include "buffer.hpp"

#include <stdexcept>
#include <utility>

#include "receiver.hpp"
#include "sender.hpp"

namespace knitting::ipc {

bool OutgoingBuffer::commit_owned(std::uint64_t id) {
  return owner_->commit(*this, id);
}
void OutgoingBuffer::cancel_owned() noexcept {
  owner_->cancel(*this);
}

void IncomingBuffer::release_owned() noexcept {
  owner_->release(storage_, index_);
}

}  // namespace knitting::ipc
