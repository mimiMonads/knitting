#define _GNU_SOURCE

#ifndef __linux__
#error "This version is Linux-only: memfd_create + mmap + futex."
#endif

#include <napi.h>

#include <cerrno>
#include <climits>
#include <cstdint>
#include <cstring>
#include <string>

#include <fcntl.h>
#include <linux/futex.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

namespace {

constexpr size_t CACHE_LINE_SIZE = 64;

size_t AlignUp(size_t value, size_t alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

int CreateMemfd(const char* name) {
  // flags = 0 keeps the fd simple for inheritance/passing.
  // Later, you can use MFD_CLOEXEC if you want stricter fd lifecycle.
  return static_cast<int>(syscall(SYS_memfd_create, name, 0));
}

int FutexWait(uint32_t* addr, uint32_t expected, const struct timespec* timeout) {
  return static_cast<int>(syscall(
    SYS_futex,
    reinterpret_cast<int*>(addr),
    FUTEX_WAIT,   // shared futex, not FUTEX_WAIT_PRIVATE
    static_cast<int>(expected),
    timeout,
    nullptr,
    0
  ));
}

int FutexWake(uint32_t* addr, int count) {
  return static_cast<int>(syscall(
    SYS_futex,
    reinterpret_cast<int*>(addr),
    FUTEX_WAKE,   // shared futex, not FUTEX_WAKE_PRIVATE
    count,
    nullptr,
    nullptr,
    0
  ));
}

} // namespace

class ShmRegion final : public Napi::ObjectWrap<ShmRegion> {
public:
  static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    Napi::Function cls = DefineClass(env, "ShmRegion", {
      InstanceMethod("fd", &ShmRegion::Fd),
      InstanceMethod("size", &ShmRegion::Size),
      InstanceMethod("baseAddressMod64", &ShmRegion::BaseAddressMod64),
      InstanceMethod("isOffsetAligned", &ShmRegion::IsOffsetAligned),

      InstanceMethod("asArrayBuffer", &ShmRegion::AsArrayBuffer),

      InstanceMethod("readU8", &ShmRegion::ReadU8),
      InstanceMethod("writeU8", &ShmRegion::WriteU8),
      InstanceMethod("readU32", &ShmRegion::ReadU32),
      InstanceMethod("writeU32", &ShmRegion::WriteU32),

      InstanceMethod("clear", &ShmRegion::Clear),
      InstanceMethod("fill", &ShmRegion::Fill),

      InstanceMethod("atomicLoadU32", &ShmRegion::AtomicLoadU32),
      InstanceMethod("atomicStoreU32", &ShmRegion::AtomicStoreU32),
      InstanceMethod("atomicExchangeU32", &ShmRegion::AtomicExchangeU32),
      InstanceMethod("atomicCompareExchangeU32", &ShmRegion::AtomicCompareExchangeU32),

      InstanceMethod("atomicAddU32", &ShmRegion::AtomicAddU32),
      InstanceMethod("atomicSubU32", &ShmRegion::AtomicSubU32),
      InstanceMethod("atomicAndU32", &ShmRegion::AtomicAndU32),
      InstanceMethod("atomicOrU32", &ShmRegion::AtomicOrU32),
      InstanceMethod("atomicXorU32", &ShmRegion::AtomicXorU32),

      InstanceMethod("fence", &ShmRegion::Fence),

      InstanceMethod("waitU32", &ShmRegion::WaitU32),
      InstanceMethod("wakeU32", &ShmRegion::WakeU32)
    });

    constructor = Napi::Persistent(cls);
    constructor.SuppressDestruct();

    exports.Set("ShmRegion", cls);
    exports.Set("createRegion", Napi::Function::New(env, CreateRegion));
    exports.Set("mapFd", Napi::Function::New(env, MapFd));

    exports.Set("CACHE_LINE_SIZE", Napi::Number::New(env, CACHE_LINE_SIZE));

    return exports;
  }

  ShmRegion(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<ShmRegion>(info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
      ThrowType(env, "size must be a number");
      return;
    }

    int64_t requestedSize = info[0].As<Napi::Number>().Int64Value();

    if (requestedSize <= 0) {
      ThrowRange(env, "size must be positive");
      return;
    }

    size_ = AlignUp(static_cast<size_t>(requestedSize), CACHE_LINE_SIZE);

    // Constructor modes:
    //   new ShmRegion(size)       -> create fresh memfd + mmap
    //   new ShmRegion(size, fd)   -> dup existing fd + mmap
    if (info.Length() >= 2 && info[1].IsNumber()) {
      int inputFd = info[1].As<Napi::Number>().Int32Value();

      if (inputFd < 0) {
        ThrowRange(env, "fd must be non-negative");
        return;
      }

      fd_ = dup(inputFd);

      if (fd_ == -1) {
        ThrowErrno(env, "dup(fd) failed");
        return;
      }
    } else {
      fd_ = CreateMemfd("knitting_shm");

      if (fd_ == -1) {
        ThrowErrno(env, "memfd_create failed");
        return;
      }

      if (ftruncate(fd_, static_cast<off_t>(size_)) == -1) {
        int saved = errno;
        close(fd_);
        fd_ = -1;
        ThrowErrno(env, "ftruncate failed", saved);
        return;
      }
    }

    void* mapped = mmap(
      nullptr,
      size_,
      PROT_READ | PROT_WRITE,
      MAP_SHARED,
      fd_,
      0
    );

    if (mapped == MAP_FAILED) {
      int saved = errno;
      close(fd_);
      fd_ = -1;
      ThrowErrno(env, "mmap failed", saved);
      return;
    }

    ptr_ = static_cast<uint8_t*>(mapped);

    // Linux mmap is page-aligned, so this should be 64-byte aligned.
    if ((reinterpret_cast<uintptr_t>(ptr_) % CACHE_LINE_SIZE) != 0) {
      munmap(ptr_, size_);
      ptr_ = nullptr;

      close(fd_);
      fd_ = -1;

      ThrowError(env, "mmap base address is not 64-byte aligned");
      return;
    }
  }

  ~ShmRegion() {
    if (ptr_ != nullptr) {
      munmap(ptr_, size_);
      ptr_ = nullptr;
    }

    if (fd_ >= 0) {
      close(fd_);
      fd_ = -1;
    }
  }

private:
  static Napi::FunctionReference constructor;

  int fd_ = -1;
  size_t size_ = 0;
  uint8_t* ptr_ = nullptr;

  static Napi::Value CreateRegion(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1) {
      ThrowType(env, "createRegion(size) requires size");
      return env.Undefined();
    }

    return constructor.New({ info[0] });
  }

  static Napi::Value MapFd(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
      ThrowType(env, "mapFd(fd, size) requires fd and size");
      return env.Undefined();
    }

    // Public API: mapFd(fd, size)
    // Constructor API: new ShmRegion(size, fd)
    return constructor.New({ info[1], info[0] });
  }

  static void ThrowError(Napi::Env env, const std::string& message) {
    Napi::Error::New(env, message).ThrowAsJavaScriptException();
  }

  static void ThrowType(Napi::Env env, const std::string& message) {
    Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
  }

  static void ThrowRange(Napi::Env env, const std::string& message) {
    Napi::RangeError::New(env, message).ThrowAsJavaScriptException();
  }

  static void ThrowErrno(
    Napi::Env env,
    const std::string& message,
    int err = errno
  ) {
    std::string full = message + ": " + std::strerror(err);
    Napi::Error::New(env, full).ThrowAsJavaScriptException();
  }

  bool CheckMapped(Napi::Env env) const {
    if (ptr_ == nullptr || fd_ < 0 || size_ == 0) {
      ThrowError(env, "shared memory region is not mapped");
      return false;
    }

    return true;
  }

  bool GetOffset(
    const Napi::CallbackInfo& info,
    size_t width,
    size_t alignment,
    size_t* out
  ) const {
    Napi::Env env = info.Env();

    if (!CheckMapped(env)) {
      return false;
    }

    if (info.Length() < 1 || !info[0].IsNumber()) {
      ThrowType(env, "offset must be a number");
      return false;
    }

    int64_t rawOffset = info[0].As<Napi::Number>().Int64Value();

    if (rawOffset < 0) {
      ThrowRange(env, "offset must be non-negative");
      return false;
    }

    size_t offset = static_cast<size_t>(rawOffset);

    if (width > size_ || offset > size_ - width) {
      ThrowRange(env, "offset out of bounds");
      return false;
    }

    if (alignment != 0 && (offset % alignment) != 0) {
      ThrowRange(env, "offset is not properly aligned");
      return false;
    }

    *out = offset;
    return true;
  }

  bool GetRange(
    const Napi::CallbackInfo& info,
    size_t offsetIndex,
    size_t lengthIndex,
    size_t* offsetOut,
    size_t* lengthOut
  ) const {
    Napi::Env env = info.Env();

    if (!CheckMapped(env)) {
      return false;
    }

    if (
      info.Length() <= offsetIndex ||
      !info[offsetIndex].IsNumber() ||
      info.Length() <= lengthIndex ||
      !info[lengthIndex].IsNumber()
    ) {
      ThrowType(env, "offset and length must be numbers");
      return false;
    }

    int64_t rawOffset = info[offsetIndex].As<Napi::Number>().Int64Value();
    int64_t rawLength = info[lengthIndex].As<Napi::Number>().Int64Value();

    if (rawOffset < 0 || rawLength < 0) {
      ThrowRange(env, "offset and length must be non-negative");
      return false;
    }

    size_t offset = static_cast<size_t>(rawOffset);
    size_t length = static_cast<size_t>(rawLength);

    if (length > size_ || offset > size_ - length) {
      ThrowRange(env, "range out of bounds");
      return false;
    }

    *offsetOut = offset;
    *lengthOut = length;
    return true;
  }

  uint32_t* U32Ptr(size_t offset) const {
    return reinterpret_cast<uint32_t*>(ptr_ + offset);
  }

  static void ExternalArrayBufferFinalizer(
    napi_env env,
    void* data,
    void* hint
  ) {
    (void)env;
    (void)data;

    ShmRegion* self = static_cast<ShmRegion*>(hint);
    self->Unref();
  }

  Napi::Value Fd(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), fd_);
  }

  Napi::Value Size(const Napi::CallbackInfo& info) {
    return Napi::Number::New(info.Env(), static_cast<double>(size_));
  }

  Napi::Value BaseAddressMod64(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!CheckMapped(env)) {
      return env.Undefined();
    }

    uintptr_t mod = reinterpret_cast<uintptr_t>(ptr_) % CACHE_LINE_SIZE;
    return Napi::Number::New(env, static_cast<double>(mod));
  }

  Napi::Value IsOffsetAligned(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber()) {
      ThrowType(env, "offset must be a number");
      return env.Undefined();
    }

    int64_t rawOffset = info[0].As<Napi::Number>().Int64Value();

    if (rawOffset < 0) {
      ThrowRange(env, "offset must be non-negative");
      return env.Undefined();
    }

    size_t alignment = CACHE_LINE_SIZE;

    if (info.Length() >= 2 && info[1].IsNumber()) {
      int64_t rawAlignment = info[1].As<Napi::Number>().Int64Value();

      if (rawAlignment <= 0) {
        ThrowRange(env, "alignment must be positive");
        return env.Undefined();
      }

      alignment = static_cast<size_t>(rawAlignment);
    }

    bool aligned = (static_cast<size_t>(rawOffset) % alignment) == 0;
    return Napi::Boolean::New(env, aligned);
  }

  Napi::Value AsArrayBuffer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!CheckMapped(env)) {
      return env.Undefined();
    }

    // Keep this ShmRegion alive while the JS ArrayBuffer exists.
    this->Ref();

    napi_value result;
    napi_status status = napi_create_external_arraybuffer(
      env,
      ptr_,
      size_,
      ShmRegion::ExternalArrayBufferFinalizer,
      this,
      &result
    );

    if (status != napi_ok) {
      this->Unref();
      ThrowError(env, "napi_create_external_arraybuffer failed");
      return env.Undefined();
    }

    return Napi::Value(env, result);
  }

  Napi::Value ReadU8(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint8_t), alignof(uint8_t), &offset)) {
      return env.Undefined();
    }

    return Napi::Number::New(env, ptr_[offset]);
  }

  void WriteU8(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint8_t), alignof(uint8_t), &offset)) {
      return;
    }

    if (info.Length() < 2 || !info[1].IsNumber()) {
      ThrowType(env, "value must be a number");
      return;
    }

    uint32_t raw = info[1].As<Napi::Number>().Uint32Value();
    ptr_[offset] = static_cast<uint8_t>(raw & 0xffu);
  }

  Napi::Value ReadU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    uint32_t value;
    std::memcpy(&value, ptr_ + offset, sizeof(uint32_t));

    return Napi::Number::New(env, value);
  }

  void WriteU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return;
    }

    if (info.Length() < 2 || !info[1].IsNumber()) {
      ThrowType(env, "value must be a number");
      return;
    }

    uint32_t value = info[1].As<Napi::Number>().Uint32Value();
    std::memcpy(ptr_ + offset, &value, sizeof(uint32_t));
  }

  void Clear(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!CheckMapped(env)) {
      return;
    }

    std::memset(ptr_, 0, size_);
  }

  void Fill(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!CheckMapped(env)) {
      return;
    }

    if (info.Length() < 1 || !info[0].IsNumber()) {
      ThrowType(env, "fill(value[, offset, length]) requires value");
      return;
    }

    int value = static_cast<int>(info[0].As<Napi::Number>().Uint32Value() & 0xffu);

    size_t offset = 0;
    size_t length = size_;

    if (info.Length() >= 3) {
      if (!GetRange(info, 1, 2, &offset, &length)) {
        return;
      }
    } else if (info.Length() >= 2) {
      if (!info[1].IsNumber()) {
        ThrowType(env, "offset must be a number");
        return;
      }

      int64_t rawOffset = info[1].As<Napi::Number>().Int64Value();

      if (rawOffset < 0) {
        ThrowRange(env, "offset must be non-negative");
        return;
      }

      offset = static_cast<size_t>(rawOffset);

      if (offset > size_) {
        ThrowRange(env, "offset out of bounds");
        return;
      }

      length = size_ - offset;
    }

    std::memset(ptr_ + offset, value, length);
  }

  Napi::Value AtomicLoadU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    uint32_t value = __atomic_load_n(U32Ptr(offset), __ATOMIC_SEQ_CST);
    return Napi::Number::New(env, value);
  }

  void AtomicStoreU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return;
    }

    if (info.Length() < 2 || !info[1].IsNumber()) {
      ThrowType(env, "value must be a number");
      return;
    }

    uint32_t value = info[1].As<Napi::Number>().Uint32Value();
    __atomic_store_n(U32Ptr(offset), value, __ATOMIC_SEQ_CST);
  }

  Napi::Value AtomicExchangeU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    if (info.Length() < 2 || !info[1].IsNumber()) {
      ThrowType(env, "value must be a number");
      return env.Undefined();
    }

    uint32_t value = info[1].As<Napi::Number>().Uint32Value();
    uint32_t previous = __atomic_exchange_n(U32Ptr(offset), value, __ATOMIC_SEQ_CST);

    return Napi::Number::New(env, previous);
  }

  Napi::Value AtomicCompareExchangeU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    if (
      info.Length() < 3 ||
      !info[1].IsNumber() ||
      !info[2].IsNumber()
    ) {
      ThrowType(env, "atomicCompareExchangeU32(offset, expected, desired) requires expected and desired");
      return env.Undefined();
    }

    uint32_t expected = info[1].As<Napi::Number>().Uint32Value();
    uint32_t desired = info[2].As<Napi::Number>().Uint32Value();

    uint32_t observed = expected;

    bool ok = __atomic_compare_exchange_n(
      U32Ptr(offset),
      &observed,
      desired,
      false,
      __ATOMIC_SEQ_CST,
      __ATOMIC_SEQ_CST
    );

    Napi::Object result = Napi::Object::New(env);
    result.Set("ok", Napi::Boolean::New(env, ok));
    result.Set("previous", Napi::Number::New(env, observed));

    return result;
  }

  Napi::Value AtomicAddU32(const Napi::CallbackInfo& info) {
    return AtomicFetchOp(info, "value", [](uint32_t* p, uint32_t v) {
      return __atomic_fetch_add(p, v, __ATOMIC_SEQ_CST);
    });
  }

  Napi::Value AtomicSubU32(const Napi::CallbackInfo& info) {
    return AtomicFetchOp(info, "value", [](uint32_t* p, uint32_t v) {
      return __atomic_fetch_sub(p, v, __ATOMIC_SEQ_CST);
    });
  }

  Napi::Value AtomicAndU32(const Napi::CallbackInfo& info) {
    return AtomicFetchOp(info, "mask", [](uint32_t* p, uint32_t v) {
      return __atomic_fetch_and(p, v, __ATOMIC_SEQ_CST);
    });
  }

  Napi::Value AtomicOrU32(const Napi::CallbackInfo& info) {
    return AtomicFetchOp(info, "mask", [](uint32_t* p, uint32_t v) {
      return __atomic_fetch_or(p, v, __ATOMIC_SEQ_CST);
    });
  }

  Napi::Value AtomicXorU32(const Napi::CallbackInfo& info) {
    return AtomicFetchOp(info, "mask", [](uint32_t* p, uint32_t v) {
      return __atomic_fetch_xor(p, v, __ATOMIC_SEQ_CST);
    });
  }

  template <typename Op>
  Napi::Value AtomicFetchOp(
    const Napi::CallbackInfo& info,
    const char* valueName,
    Op op
  ) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    if (info.Length() < 2 || !info[1].IsNumber()) {
      ThrowType(env, std::string(valueName) + " must be a number");
      return env.Undefined();
    }

    uint32_t value = info[1].As<Napi::Number>().Uint32Value();
    uint32_t previous = op(U32Ptr(offset), value);

    return Napi::Number::New(env, previous);
  }

  void Fence(const Napi::CallbackInfo& info) {
    (void)info;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
  }

  Napi::Value WaitU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    if (info.Length() < 2 || !info[1].IsNumber()) {
      ThrowType(env, "expected value must be a number");
      return env.Undefined();
    }

    uint32_t expected = info[1].As<Napi::Number>().Uint32Value();

    struct timespec ts;
    struct timespec* timeoutPtr = nullptr;

    // Optional third argument:
    //   waitU32(offset, expected, timeoutMs)
    //
    // timeoutMs < 0 or omitted means infinite wait.
    if (info.Length() >= 3 && info[2].IsNumber()) {
      double timeoutMs = info[2].As<Napi::Number>().DoubleValue();

      if (timeoutMs >= 0) {
        time_t sec = static_cast<time_t>(timeoutMs / 1000.0);
        long nsec = static_cast<long>((timeoutMs - (static_cast<double>(sec) * 1000.0)) * 1000000.0);

        if (nsec < 0) {
          nsec = 0;
        }

        if (nsec > 999999999L) {
          nsec = 999999999L;
        }

        ts.tv_sec = sec;
        ts.tv_nsec = nsec;
        timeoutPtr = &ts;
      }
    }

    int rc = FutexWait(U32Ptr(offset), expected, timeoutPtr);

    if (rc == 0) {
      return Napi::String::New(env, "woken");
    }

    int saved = errno;

    if (saved == EAGAIN) {
      return Napi::String::New(env, "changed");
    }

    if (saved == EINTR) {
      return Napi::String::New(env, "interrupted");
    }

    if (saved == ETIMEDOUT) {
      return Napi::String::New(env, "timed-out");
    }

    ThrowErrno(env, "futex wait failed", saved);
    return env.Undefined();
  }

  Napi::Value WakeU32(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    size_t offset = 0;

    if (!GetOffset(info, sizeof(uint32_t), alignof(uint32_t), &offset)) {
      return env.Undefined();
    }

    int count = 1;

    if (info.Length() >= 2 && info[1].IsNumber()) {
      count = info[1].As<Napi::Number>().Int32Value();
    }

    if (count <= 0) {
      count = INT_MAX;
    }

    int woken = FutexWake(U32Ptr(offset), count);

    if (woken == -1) {
      ThrowErrno(env, "futex wake failed");
      return env.Undefined();
    }

    return Napi::Number::New(env, woken);
  }
};

Napi::FunctionReference ShmRegion::constructor;

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  return ShmRegion::Init(env, exports);
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, Init)
