#include "knitting_ipc.hpp"

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <signal.h>
#include <stdexcept>
#include <string>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

using namespace knitting::ipc;
#define EXPECT(condition) do { if (!(condition)) throw std::runtime_error( \
  std::string(__func__) + ":" + std::to_string(__LINE__) + ": " #condition); } while (false)

template<class Function> void throws(Function function) {
  bool caught = false;
  try { function(); } catch (const std::exception&) { caught = true; }
  EXPECT(caught);
}
void fill(std::span<std::byte> bytes, unsigned value) {
  std::fill(bytes.begin(), bytes.end(), std::byte(value % 251));
}
void verify(std::span<const std::byte> bytes, unsigned value) {
  EXPECT(std::all_of(bytes.begin(), bytes.end(), [=](auto b) { return b == std::byte(value % 251); }));
}

void inline_capacity_and_release() {
  auto mapping = Mapping::create(4096);
  Sender sender(mapping.lane(0), mapping.arena(0));
  Receiver receiver(mapping.lane(0), mapping.arena(0));
  std::vector<IncomingBuffer> held;
  for (unsigned id = 0; id < queue_slots; ++id) {
    auto outgoing = sender.try_allocate(inline_bytes); EXPECT(outgoing);
    fill(outgoing->bytes(), id); EXPECT(outgoing->commit(id));
    throws([&] { (void)outgoing->bytes(); });
    auto incoming = receiver.try_receive(); EXPECT(incoming);
    EXPECT(incoming->storage() == Storage::inline_buffer);
    held.push_back(std::move(*incoming));
  }
  EXPECT(!sender.try_allocate(1));
  EXPECT(!receiver.try_receive());  // Held inline slots are not redelivered.
  auto old_address = held[7].bytes().data();
  held[7].release(); held[7].release();
  throws([&] { (void)held[7].bytes(); });
  auto outgoing = sender.try_allocate(512); EXPECT(outgoing);
  EXPECT(outgoing->bytes().data() == old_address);
  fill(outgoing->bytes(), 99); EXPECT(outgoing->commit(99));
  auto incoming = receiver.try_receive(); EXPECT(incoming && incoming->id() == 99);
  verify(incoming->bytes(), 99);
  for (unsigned i = 0; i < held.size(); ++i) if (i != 7) verify(held[i].bytes(), i);
  EXPECT(mapping.lane(0).control.regions_published.bits[0].load() == 0);
}

void arena_lifetime_is_independent() {
  auto mapping = Mapping::create(64 * 1024);
  Sender sender(mapping.lane(0), mapping.arena(0));
  Receiver receiver(mapping.lane(0), mapping.arena(0));
  std::vector<IncomingBuffer> held;
  for (unsigned id = 0; id < region_slots; ++id) {
    auto outgoing = sender.try_allocate(1024); EXPECT(outgoing);
    fill(outgoing->bytes(), id); EXPECT(outgoing->commit(id));
    auto incoming = receiver.try_receive(); EXPECT(incoming && incoming->id() == id);
    EXPECT(incoming->storage() == Storage::arena);
    held.push_back(std::move(*incoming));
  }
  // 64 live payloads despite only 32 queue slots. Both region words are full.
  EXPECT(!sender.try_allocate(1024));
  auto tiny = sender.try_allocate(1); EXPECT(tiny); tiny->cancel();
  auto address = held[37].bytes().data();
  auto before = mapping.lane(0).control.regions_retired.bits[1].load();
  held[37].release(); held[37].release();
  EXPECT(mapping.lane(0).control.regions_retired.bits[1].load() == (before ^ (1U << 5)));
  {
    auto reused = sender.try_allocate(1024); EXPECT(reused);
    EXPECT(reused->bytes().data() == address); fill(reused->bytes(), 200);
    // Cancelling a reservation must not free somebody else's region.
  }
  for (unsigned i = 0; i < held.size(); ++i) if (i != 37) verify(held[i].bytes(), i);
  held.clear();
  auto entire_arena = sender.try_allocate(64 * 1024); EXPECT(entire_arena);
  EXPECT(entire_arena->bytes().data() == mapping.arena(0).data());
}

void arena_fragmentation_and_coalescence() {
  auto mapping = Mapping::create(4096);
  Sender sender(mapping.lane(0), mapping.arena(0));
  Receiver receiver(mapping.lane(0), mapping.arena(0));
  std::vector<IncomingBuffer> held;
  for (unsigned i = 0; i < 4; ++i) {
    auto outgoing = sender.try_allocate(1024); EXPECT(outgoing);
    fill(outgoing->bytes(), i); EXPECT(outgoing->commit(i));
    auto incoming = receiver.try_receive(); EXPECT(incoming);
    held.push_back(std::move(*incoming));
  }
  held[1].release(); held[3].release();
  EXPECT(!sender.try_allocate(1536)); // Enough total space, no contiguous gap.
  held[2].release();
  auto joined = sender.try_allocate(1536); EXPECT(joined);
  EXPECT(joined->bytes().data() == mapping.arena(0).data() + 1024);
  fill(joined->bytes(), 100); verify(held[0].bytes(), 0);
}

void commit_retry_and_cancellation() {
  auto mapping = Mapping::create(4096);
  Sender sender(mapping.lane(0), mapping.arena(0));
  Receiver receiver(mapping.lane(0), mapping.arena(0));
  for (unsigned i = 0; i < queue_slots; ++i) EXPECT(sender.try_send({}, i));
  auto pending = sender.try_allocate(1024); EXPECT(pending);
  fill(pending->bytes(), 61);
  EXPECT(!pending->commit(1000)); // Queue full, loan remains owned and usable.
  verify(pending->bytes(), 61);
  auto first = receiver.try_receive(); EXPECT(first); first->release();
  EXPECT(pending->commit(1000));
  bool found = false;
  for (unsigned i = 0; i < queue_slots; ++i) {
    auto incoming = receiver.try_receive(); EXPECT(incoming);
    if (incoming->id() == 1000) { verify(incoming->bytes(), 61); found = true; }
  }
  EXPECT(found);
  throws([&] { (void)pending->commit(1000); });
  for (unsigned i = 0; i < 1000; ++i) {
    auto small = sender.try_allocate(512); EXPECT(small);
    auto large = sender.try_allocate(4096); EXPECT(large);
    large->cancel(); large->cancel();
    throws([&] { (void)large->bytes(); });
  }
  EXPECT(!sender.try_allocate(4097));
}

void moved_handles_release_exactly_once() {
  auto mapping = Mapping::create(4096);
  Sender sender(mapping.lane(0), mapping.arena(0));
  Receiver receiver(mapping.lane(0), mapping.arena(0));
  auto left = sender.try_allocate(513), right = sender.try_allocate(1024);
  EXPECT(left && right);
  *left = std::move(*right); // Cancels left's old region, owns right's region.
  throws([&] { (void)right->bytes(); });
  fill(left->bytes(), 20); EXPECT(left->commit(20));
  auto first = receiver.try_receive(); EXPECT(first);
  auto other = sender.try_allocate(513); EXPECT(other);
  fill(other->bytes(), 30); EXPECT(other->commit(30));
  auto second = receiver.try_receive(); EXPECT(second);
  *first = std::move(*second); // Retires first's old payload exactly once.
  throws([&] { (void)second->bytes(); }); verify(first->bytes(), 30);
  first->release();
  auto all = sender.try_allocate(4096); EXPECT(all);
}

void malformed_frames_and_mapping_validation() {
  throws([] { (void)Mapping::create(63); });
  throws([] { (void)Mapping::attach(-1); });
  auto mapping = Mapping::create(4096);
  std::uint32_t other_width = queue_slots == 32 ? 64 : 32;
  EXPECT(pwrite(mapping.fd(), &other_width, sizeof(other_width), offsetof(Header, queue_slot_count)) == sizeof(other_width));
  throws([&] { (void)Mapping::attach(mapping.fd()); });
  std::uint32_t actual_width = queue_slots;
  EXPECT(pwrite(mapping.fd(), &actual_width, sizeof(actual_width), offsetof(Header, queue_slot_count)) == sizeof(actual_width));
  auto duplicate = Mapping::attach(mapping.fd());
  EXPECT(duplicate.arena(0).data() != mapping.arena(0).data());
  mapping.arena(0)[7] = std::byte{42};
  EXPECT(duplicate.arena(0)[7] == std::byte{42});
  Receiver receiver(mapping.lane(0), mapping.arena(0));
  auto& lane = mapping.lane(0);
  lane.slots[0].descriptor.storage = Storage::arena;
  lane.slots[0].descriptor.offset = 4096;
  lane.slots[0].descriptor.length = 1024;
  lane.control.published.bits.store(1, std::memory_order_release);
  throws([&] { (void)receiver.try_receive(); });
  EXPECT(lane.control.retired.bits.load() == 0); // Invalid frame fails closed.
}

std::size_t message_size(std::uint64_t id) {
  constexpr std::size_t sizes[] = {0, 1, 64, 511, 512, 513, 1024, 4096, 8192, 16384};
  return sizes[id % std::size(sizes)];
}
std::byte pattern(std::uint64_t id, std::size_t offset) {
  return std::byte((id * 17 + offset * 13 + (offset >> 8)) % 251);
}
void check_message(std::span<const std::byte> bytes, std::uint64_t id) {
  EXPECT(bytes.size() == message_size(id));
  for (std::size_t i = 0; i < bytes.size(); ++i) EXPECT(bytes[i] == pattern(id, i));
}

void cross_process_duplex() {
  constexpr std::uint64_t messages = 20000;
  auto mapping = Mapping::create(1024 * 1024);
  pid_t parent = getpid(), child = fork(); EXPECT(child >= 0);
  if (!child) {
    try {
      EXPECT(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0);
      if (getppid() != parent) _exit(2);
      alarm(30);
      auto attached = Mapping::attach(mapping.fd());
      EXPECT(attached.arena(0).data() != mapping.arena(0).data());
      mapping = Mapping{}; // Use only the independent attachment from now on.
      Receiver requests(attached.lane(0), attached.arena(0));
      Sender responses(attached.lane(1), attached.arena(1));
      std::optional<IncomingBuffer> pending;
      std::vector<bool> seen(messages);
      std::uint64_t completed = 0;
      while (completed < messages) {
        if (!pending) pending = requests.try_receive();
        if (!pending) { std::this_thread::yield(); continue; }
        auto id = pending->id(); EXPECT(id < messages && !seen[id]);
        check_message(pending->bytes(), id);
        if (!responses.try_send(pending->bytes(), id)) { std::this_thread::yield(); continue; }
        seen[id] = true; pending.reset(); ++completed;
      }
      _exit(0);
    } catch (const std::exception& error) {
      std::cerr << "child: " << error.what() << '\n'; _exit(1);
    }
  }
  Sender requests(mapping.lane(0), mapping.arena(0));
  Receiver responses(mapping.lane(1), mapping.arena(1));
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
  std::uint64_t sent = 0, received = 0;
  std::vector<bool> seen(messages);
  try {
    while (received < messages) {
      EXPECT(std::chrono::steady_clock::now() < deadline);
      if (sent < messages && sent - received < 128) {
        auto outgoing = requests.try_allocate(message_size(sent));
        if (outgoing) {
          auto bytes = outgoing->bytes();
          for (std::size_t i = 0; i < bytes.size(); ++i) bytes[i] = pattern(sent, i);
          if (outgoing->commit(sent)) ++sent;
        }
      }
      auto incoming = responses.try_receive();
      if (incoming) {
        auto id = incoming->id(); EXPECT(id < sent && !seen[id]);
        check_message(incoming->bytes(), id); seen[id] = true; ++received;
      } else std::this_thread::yield();
    }
    int status = 0; EXPECT(waitpid(child, &status, 0) == child);
    EXPECT(WIFEXITED(status) && WEXITSTATUS(status) == 0);
  } catch (...) { kill(child, SIGKILL); waitpid(child, nullptr, 0); throw; }
}

int main() try {
  alarm(60);
  const std::pair<const char*, void(*)()> tests[] = {
    {"inline slot capacity and release", inline_capacity_and_release},
    {"64 retained regions independent of queue retirement", arena_lifetime_is_independent},
    {"arena fragmentation and coalescence", arena_fragmentation_and_coalescence},
    {"full queue retry and unpublished cancellation", commit_retry_and_cancellation},
    {"move-only ownership and exactly-once release", moved_handles_release_exactly_once},
    {"mapping attachment and invalid descriptor rejection", malformed_frames_and_mapping_validation},
    {"20,000 duplex cross-process buffer round trips", cross_process_duplex},
  };
  for (auto [name, test] : tests) { test(); std::cout << "PASS " << name << '\n'; }
  std::cout << "All " << std::size(tests) << " IPC tests passed.\n";
  return 0;
} catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
