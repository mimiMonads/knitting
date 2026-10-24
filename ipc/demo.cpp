// SPDX-License-Identifier: Apache-2.0
#include <signal.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>

#include "knitting_ipc.hpp"

using namespace knitting::ipc;

int main() try {
  alarm(10);
  auto mapping = Mapping::create();
  pid_t parent = getpid(), child = fork();
  if (child < 0) {
    throw std::runtime_error("fork failed");
  }
  if (!child) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) {
      _exit(2);
    }
    auto attached = Mapping::attach(mapping.fd());
    mapping = Mapping{};
    Receiver input(attached.lane(0), attached.arena(0));
    Sender output(attached.lane(1), attached.arena(1));
    for (unsigned n = 0; n < 4; ++n) {
      std::optional<IncomingBuffer> message;
      while (!(message = input.try_receive())) {
        std::this_thread::yield();
      }
      while (!output.try_send(message->bytes(), message->id())) {
        std::this_thread::yield();
      }
      // Destruction tells the parent this input region/slot may be reused.
    }
    _exit(0);
  }
  Sender output(mapping.lane(0), mapping.arena(0));
  Receiver input(mapping.lane(1), mapping.arena(1));
  for (unsigned id = 0; id < 4; ++id) {
    std::size_t size = id % 2 ? 8192 : 128;
    auto outgoing = output.try_allocate(size);
    if (!outgoing) {
      throw std::runtime_error("allocation unexpectedly blocked");
    }
    std::fill(outgoing->bytes().begin(), outgoing->bytes().end(), std::byte(id));
    while (!outgoing->commit(id)) {
      std::this_thread::yield();
    }
    std::optional<IncomingBuffer> reply;
    while (!(reply = input.try_receive())) {
      std::this_thread::yield();
    }
    if (reply->id() != id || reply->bytes().size() != size ||
        !std::all_of(reply->bytes().begin(), reply->bytes().end(),
                     [=](auto byte) { return byte == std::byte(id); })) {
      throw std::runtime_error("reply mismatch");
    }
    std::cout << "reply " << id << ": " << size << " bytes, "
              << (reply->storage() == Storage::arena ? "arena region" : "inline slot") << '\n';
    reply->release();  // Explicit release; destruction would do the same.
  }
  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) {
    throw std::runtime_error("child failed");
  }
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
