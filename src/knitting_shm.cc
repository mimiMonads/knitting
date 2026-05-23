#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#if !defined(__linux__) && !defined(__APPLE__) && !defined(_WIN32)
#error "knitting_shm.cc currently supports Linux, macOS, and Windows best-effort wait/wake."
#endif

#include <node.h>
#include <v8.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <climits>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <thread>

#ifdef __linux__
#include <linux/futex.h>
#include <sys/syscall.h>
#endif
#include <time.h>
#ifndef _WIN32
#include <unistd.h>
#endif

namespace knitting_shm {

#ifdef __APPLE__
// These are provided by libSystem. We declare them directly so the addon can
// still compile on SDKs where <sys/ulock.h> is not exposed as a public header.
extern "C" int __ulock_wait(
  uint32_t operation,
  void* addr,
  uint64_t value,
  uint32_t timeout_us
);
extern "C" int __ulock_wake(
  uint32_t operation,
  void* addr,
  uint64_t wake_value
);

#ifndef UL_COMPARE_AND_WAIT_SHARED
#define UL_COMPARE_AND_WAIT_SHARED 3
#endif

#ifndef ULF_WAKE_ALL
#define ULF_WAKE_ALL 0x00000100
#endif
#endif

#ifdef _WIN32
uint32_t AtomicLoadU32(uint32_t* addr) {
  return std::atomic_ref<uint32_t>(*addr).load(std::memory_order_acquire);
}

uint64_t TimeoutToMillis(const struct timespec* timeout) {
  if (timeout == nullptr) return UINT64_MAX;

  uint64_t millis = static_cast<uint64_t>(timeout->tv_sec) * 1000ULL;
  millis += static_cast<uint64_t>(timeout->tv_nsec) / 1000000ULL;
  if ((timeout->tv_nsec % 1000000L) != 0) millis += 1;
  return millis;
}
#endif

int FutexWait(uint32_t* addr, uint32_t expected, const struct timespec* timeout) {
#ifdef __linux__
  return static_cast<int>(syscall(
    SYS_futex,
    reinterpret_cast<int*>(addr),
    FUTEX_WAIT,
    static_cast<int>(expected),
    timeout,
    nullptr,
    0
  ));
#elif defined(_WIN32)
  if (AtomicLoadU32(addr) != expected) {
    errno = EAGAIN;
    return -1;
  }

  uint64_t timeout_ms = TimeoutToMillis(timeout);
  const bool infinite = timeout_ms == UINT64_MAX;
  const auto started = std::chrono::steady_clock::now();
  const auto deadline = infinite
    ? std::chrono::steady_clock::time_point::max()
    : started + std::chrono::milliseconds(timeout_ms);

  while (AtomicLoadU32(addr) == expected) {
    if (!infinite && std::chrono::steady_clock::now() >= deadline) {
      errno = ETIMEDOUT;
      return -1;
    }

    if (infinite) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      continue;
    }

    auto now = std::chrono::steady_clock::now();
    if (now >= deadline) {
      errno = ETIMEDOUT;
      return -1;
    }

    auto remaining = deadline - now;
    auto one_ms = std::chrono::milliseconds(1);
    std::this_thread::sleep_for(remaining < one_ms ? remaining : one_ms);
  }

  return 0;
#else
  uint32_t timeout_us = 0;
  if (timeout != nullptr) {
    uint64_t micros =
      (static_cast<uint64_t>(timeout->tv_sec) * 1000000ULL) +
      (static_cast<uint64_t>(timeout->tv_nsec) / 1000ULL);
    if (micros == 0) micros = 1;
    timeout_us = micros > UINT32_MAX
      ? UINT32_MAX
      : static_cast<uint32_t>(micros);
  }

  return __ulock_wait(
    UL_COMPARE_AND_WAIT_SHARED,
    addr,
    static_cast<uint64_t>(expected),
    timeout_us
  );
#endif
}

int FutexWake(uint32_t* addr, int count) {
#ifdef __linux__
  return static_cast<int>(syscall(
    SYS_futex,
    reinterpret_cast<int*>(addr),
    FUTEX_WAKE,
    count,
    nullptr,
    nullptr,
    0
  ));
#elif defined(_WIN32)
  (void)addr;
  return count <= 0 ? 0 : 1;
#else
  uint32_t operation = UL_COMPARE_AND_WAIT_SHARED;
  if (count <= 0 || count == INT_MAX) {
    operation |= ULF_WAKE_ALL;
  }

  int rc = __ulock_wake(operation, addr, 0);
  if (rc == 0) {
    return 1;
  }

  if (errno == ENOENT) {
    return 0;
  }

  return -1;
#endif
}

void ThrowErrno(v8::Isolate* isolate, const char* message, int err = errno) {
  std::string full = std::string(message) + ": " + std::strerror(err);
  isolate->ThrowException(v8::Exception::Error(
    v8::String::NewFromUtf8(isolate, full.c_str()).ToLocalChecked()
  ));
}

void ThrowType(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::TypeError(
    v8::String::NewFromUtf8(isolate, message).ToLocalChecked()
  ));
}

void ThrowRange(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::RangeError(
    v8::String::NewFromUtf8(isolate, message).ToLocalChecked()
  ));
}

bool ReadU32Argument(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  int index,
  uint32_t* out
) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() <= index || !args[index]->IsNumber()) {
    ThrowType(isolate, "expected a number argument");
    return false;
  }

  v8::Maybe<uint32_t> maybe = args[index]->Uint32Value(context);
  if (maybe.IsNothing()) {
    ThrowType(isolate, "expected a valid uint32 argument");
    return false;
  }

  *out = maybe.FromJust();
  return true;
}

bool ReadSizeArgument(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  int index,
  size_t* out
) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() <= index || !args[index]->IsNumber()) {
    ThrowType(isolate, "expected a number argument");
    return false;
  }

  v8::Maybe<int64_t> maybe = args[index]->IntegerValue(context);
  if (maybe.IsNothing() || maybe.FromJust() < 0) {
    ThrowRange(isolate, "offset must be non-negative");
    return false;
  }

  *out = static_cast<size_t>(maybe.FromJust());
  return true;
}

bool ReadOptionalMillis(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  int index,
  double fallback,
  double* out
) {
  *out = fallback;

  if (args.Length() <= index || args[index]->IsUndefined() || args[index]->IsNull()) {
    return true;
  }

  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (!args[index]->IsNumber()) {
    ThrowType(isolate, "milliseconds must be a number");
    return false;
  }

  v8::Maybe<double> maybe = args[index]->NumberValue(context);
  if (maybe.IsNothing()) {
    ThrowType(isolate, "milliseconds must be a valid number");
    return false;
  }

  double value = maybe.FromJust();
  if (value != value) {
    ThrowRange(isolate, "milliseconds must not be NaN");
    return false;
  }

  *out = value < 0 ? 0 : value;
  return true;
}

bool GetBackingStore(
  v8::Isolate* isolate,
  v8::Local<v8::Value> value,
  std::shared_ptr<v8::BackingStore>* out
) {
  if (value->IsSharedArrayBuffer()) {
    *out = value.As<v8::SharedArrayBuffer>()->GetBackingStore();
    return true;
  }

  if (value->IsArrayBuffer()) {
    *out = value.As<v8::ArrayBuffer>()->GetBackingStore();
    return true;
  }

  ThrowType(isolate, "first argument must be an ArrayBuffer or SharedArrayBuffer");
  return false;
}

bool GetU32Pointer(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  uint32_t** out
) {
  v8::Isolate* isolate = args.GetIsolate();

  if (args.Length() < 2) {
    ThrowType(isolate, "expected buffer and byteOffset");
    return false;
  }

  std::shared_ptr<v8::BackingStore> backing;
  if (!GetBackingStore(isolate, args[0], &backing)) {
    return false;
  }

  size_t offset = 0;
  if (!ReadSizeArgument(args, 1, &offset)) {
    return false;
  }

  if ((offset % alignof(uint32_t)) != 0) {
    ThrowRange(isolate, "byteOffset must be uint32-aligned");
    return false;
  }

  if (backing->ByteLength() < sizeof(uint32_t) || offset > backing->ByteLength() - sizeof(uint32_t)) {
    ThrowRange(isolate, "byteOffset out of bounds");
    return false;
  }

  *out = reinterpret_cast<uint32_t*>(
    static_cast<uint8_t*>(backing->Data()) + offset
  );
  return true;
}

bool ReadTimeout(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  int index,
  struct timespec* timeout,
  struct timespec** out
) {
  *out = nullptr;

  if (args.Length() <= index || args[index]->IsUndefined() || args[index]->IsNull()) {
    return true;
  }

  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (!args[index]->IsNumber()) {
    ThrowType(isolate, "timeoutMs must be a number");
    return false;
  }

  v8::Maybe<double> maybe = args[index]->NumberValue(context);
  if (maybe.IsNothing()) {
    ThrowType(isolate, "timeoutMs must be a valid number");
    return false;
  }

  double timeoutMs = maybe.FromJust();
  if (timeoutMs < 0) {
    return true;
  }

  time_t sec = static_cast<time_t>(timeoutMs / 1000.0);
  long nsec = static_cast<long>(
    (timeoutMs - (static_cast<double>(sec) * 1000.0)) * 1000000.0
  );

  if (nsec < 0) nsec = 0;
  if (nsec > 999999999L) nsec = 999999999L;

  timeout->tv_sec = sec;
  timeout->tv_nsec = nsec;
  *out = timeout;
  return true;
}

void WaitU32(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  uint32_t* ptr = nullptr;
  if (!GetU32Pointer(args, &ptr)) {
    return;
  }

  uint32_t expected = 0;
  if (!ReadU32Argument(args, 2, &expected)) {
    return;
  }

  struct timespec timeout;
  struct timespec* timeout_ptr = nullptr;
  if (!ReadTimeout(args, 3, &timeout, &timeout_ptr)) {
    return;
  }

  int rc = FutexWait(ptr, expected, timeout_ptr);
  if (rc == 0) {
    args.GetReturnValue().Set(
      v8::String::NewFromUtf8Literal(isolate, "woken")
    );
    return;
  }

  int saved = errno;
  if (saved == EAGAIN) {
    args.GetReturnValue().Set(
      v8::String::NewFromUtf8Literal(isolate, "changed")
    );
    return;
  }
  if (saved == EINTR) {
    args.GetReturnValue().Set(
      v8::String::NewFromUtf8Literal(isolate, "interrupted")
    );
    return;
  }
  if (saved == ETIMEDOUT) {
    args.GetReturnValue().Set(
      v8::String::NewFromUtf8Literal(isolate, "timed-out")
    );
    return;
  }

  ThrowErrno(isolate, "futex wait failed", saved);
}

void WakeU32(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  uint32_t* ptr = nullptr;
  if (!GetU32Pointer(args, &ptr)) {
    return;
  }

  uint32_t raw_count = 1;
  if (args.Length() >= 3 && !args[2]->IsUndefined()) {
    if (!ReadU32Argument(args, 2, &raw_count)) {
      return;
    }
  }

  int count = raw_count == 0 ? INT_MAX : static_cast<int>(raw_count);
  int woken = FutexWake(ptr, count);
  if (woken == -1) {
    ThrowErrno(isolate, "futex wake failed");
    return;
  }

  args.GetReturnValue().Set(v8::Integer::New(isolate, woken));
}

void Sleep(const v8::FunctionCallbackInfo<v8::Value>& args) {
  double milliseconds = 1;
  if (!ReadOptionalMillis(args, 0, 1, &milliseconds)) {
    return;
  }

  std::this_thread::sleep_for(
    std::chrono::duration<double, std::milli>(milliseconds)
  );
}

void Yield(const v8::FunctionCallbackInfo<v8::Value>& args) {
  (void)args;
  std::this_thread::yield();
}

void Initialize(v8::Local<v8::Object> exports) {
  NODE_SET_METHOD(exports, "waitU32", WaitU32);
  NODE_SET_METHOD(exports, "wakeU32", WakeU32);
  NODE_SET_METHOD(exports, "notifyU32", WakeU32);
  NODE_SET_METHOD(exports, "sleep", Sleep);
  NODE_SET_METHOD(exports, "yield", Yield);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)

}  // namespace knitting_shm
