// SPDX-License-Identifier: Apache-2.0
// Benchmarks the actual buffer channel, including allocation and release.
#include "support.hpp"

int main(int argc, char** argv) try {
  check(argc == 7, "usage: benchmark MODE BYTES WINDOW ROUNDS HOST_CPU WORKER_CPU");
  std::string mode = argv[1];
  check(mode == "ipc-copy" || mode == "ipc-direct" || mode == "uds-copy" || mode == "uds-direct",
        "invalid mode");
  bool ipc = mode.starts_with("ipc-"), direct = mode.ends_with("direct");
  std::size_t size = std::stoull(argv[2]), window = std::stoull(argv[3]);
  std::uint32_t rounds = std::stoul(argv[4]);
  check(size && size <= 1024 * 1024 && window && window <= 64 && rounds && rounds <= 10000000,
        "invalid dimensions");
  int host_cpu = std::stoi(argv[5]), worker_cpu = std::stoi(argv[6]);
  check(host_cpu != worker_cpu, "need distinct CPUs");
  pin(host_cpu);
  auto arena_size =
      std::max<std::size_t>(4 * 1024 * 1024, ((size + 63) & ~std::size_t{63}) * window);
  auto mapping = Mapping::create(static_cast<std::uint32_t>(arena_size));
  std::vector<std::byte> source(size * window, std::byte{91});
  std::vector<std::byte> received(size * window);
  int sockets[2];
  check(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0, "socketpair failed");
  std::uint32_t warmup = std::min<std::uint32_t>(1000, rounds);
  alarm(90);
  pid_t parent = getpid(), child = fork();
  check(child >= 0, "fork failed");
  if (!child) {
    check(prctl(PR_SET_PDEATHSIG, SIGKILL) == 0 && getppid() == parent, "parent died");
    close(sockets[0]);
    pin(worker_cpu);
    auto attached = Mapping::attach(mapping.fd());
    mapping = Mapping{};
    Receiver input(attached.lane(0), attached.arena(0));
    Sender output(attached.lane(1), attached.arena(1));
    char ready = 'R';
    send_all(sockets[1], &ready, 1);
    double cpu_start = 0;
    for (std::uint32_t round = 0; round < warmup + rounds; ++round) {
      if (round == warmup) {
        cpu_start = cpu_seconds();
      }
      if (ipc) {
        for (std::size_t i = 0; i < window; ++i) {
          std::optional<IncomingBuffer> incoming;
          while (!(incoming = input.try_receive())) {
            relax();
          }
          auto id = incoming->id();
          check(id >= std::uint64_t(round) * window && id < std::uint64_t(round + 1) * window,
                "wrong request ID");
          check(incoming->bytes().size() == size, "wrong request length");
          auto sum = checksum(incoming->bytes());
          check(sum == expected(size, id), "payload mismatch");
          incoming->release();
          Reply reply{id, sum};
          auto bytes = std::as_bytes(std::span(&reply, 1));
          while (!output.try_send(bytes, id)) {
            relax();
          }
        }
      } else {
        std::array<Request, 64> requests;
        std::array<Reply, 64> replies;
        receive_all(sockets[1], requests.data(), window * sizeof(Request));
        receive_all(sockets[1], received.data(), received.size());
        for (std::size_t i = 0; i < window; ++i) {
          auto id = requests[i].id;
          check(id == std::uint64_t(round) * window + i && requests[i].length == size,
                "invalid socket request");
          auto sum = checksum(std::span(received).subspan(i * size, size));
          check(sum == expected(size, id), "socket payload mismatch");
          replies[i] = {id, sum};
        }
        send_all(sockets[1], replies.data(), window * sizeof(Reply));
      }
    }
    double used = cpu_seconds() - cpu_start;
    send_all(sockets[1], &used, sizeof(used));
    _exit(0);
  }
  close(sockets[1]);
  Sender output(mapping.lane(0), mapping.arena(0));
  Receiver input(mapping.lane(1), mapping.arena(1));
  char ready;
  receive_all(sockets[0], &ready, 1);
  check(ready == 'R', "worker handshake");
  std::vector<double> samples;
  samples.reserve(rounds);
  double cpu_start = 0;
  Clock::time_point start;
  for (std::uint32_t round = 0; round < warmup + rounds; ++round) {
    if (round == warmup) {
      cpu_start = cpu_seconds();
      start = Clock::now();
    }
    auto batch_start = Clock::now();
    std::array<Request, 64> requests;
    for (std::size_t i = 0; i < window; ++i) {
      auto id = std::uint64_t(round) * window + i;
      auto bytes = std::span(source).subspan(i * size, size);
      if (ipc && direct) {
        std::optional<OutgoingBuffer> outgoing;
        while (!(outgoing = output.try_allocate(size))) {
          relax();
        }
        produce(outgoing->bytes(), id, true);
        while (!outgoing->commit(id)) {
          relax();
        }
      } else {
        produce(bytes, id, direct);
        if (ipc) {
          while (!output.try_send(bytes, id)) {
            relax();
          }
        } else {
          requests[i] = {id, size};
        }
      }
    }
    std::array<bool, 64> seen{};
    auto validate = [&](Reply reply) {
      auto first = std::uint64_t(round) * window;
      check(reply.id >= first && reply.id < first + window, "reply outside batch");
      check(!seen[reply.id - first], "duplicate reply");
      seen[reply.id - first] = true;
      check(reply.checksum == expected(size, reply.id), "reply checksum mismatch");
    };
    if (ipc) {
      for (std::size_t i = 0; i < window; ++i) {
        std::optional<IncomingBuffer> reply;
        while (!(reply = input.try_receive())) {
          relax();
        }
        check(reply->bytes().size() == sizeof(Reply), "invalid reply size");
        Reply value;
        std::memcpy(&value, reply->bytes().data(), sizeof(value));
        check(reply->id() == value.id, "reply descriptor mismatch");
        validate(value);
        reply->release();
      }
    } else {
      std::array<Reply, 64> replies;
      send_all(sockets[0], requests.data(), window * sizeof(Request));
      send_all(sockets[0], source.data(), source.size());
      receive_all(sockets[0], replies.data(), window * sizeof(Reply));
      for (std::size_t i = 0; i < window; ++i) {
        validate(replies[i]);
      }
    }
    if (round >= warmup) {
      samples.push_back(
          std::chrono::duration<double, std::micro>(Clock::now() - batch_start).count());
    }
  }
  double elapsed = std::chrono::duration<double>(Clock::now() - start).count();
  double host_cpu_used = cpu_seconds() - cpu_start, worker_cpu_used;
  receive_all(sockets[0], &worker_cpu_used, sizeof(worker_cpu_used));
  int status;
  check(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "worker failed");
  std::sort(samples.begin(), samples.end());
  auto percentile = [&](double p) {
    return samples[std::min(samples.size() - 1, std::size_t(samples.size() * p))];
  };
  auto calls = std::uint64_t(rounds) * window;
  std::cout << "{\"mode\":\"" << mode << "\",\"bytes\":" << size << ",\"window\":" << window
            << ",\"queue_slots\":" << queue_slots << ",\"rounds\":" << rounds
            << ",\"seconds\":" << elapsed << ",\"calls_per_second\":" << calls / elapsed
            << ",\"batch_p50_us\":" << percentile(.5) << ",\"batch_p99_us\":" << percentile(.99)
            << ",\"cpu_us_per_call\":" << (host_cpu_used + worker_cpu_used) * 1e6 / calls
            << ",\"host_cpu_seconds\":" << host_cpu_used
            << ",\"worker_cpu_seconds\":" << worker_cpu_used << ",\"validated_calls\":" << calls
            << "}\n";
  close(sockets[0]);
  return 0;
} catch (const std::exception& error) {
  std::cerr << error.what() << '\n';
  return 1;
}
