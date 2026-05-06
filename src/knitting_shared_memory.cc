#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#if !defined(__linux__) && !defined(__APPLE__)
#error "knitting_shared_memory.cc currently supports Linux and macOS."
#endif

#include <node.h>
#include <v8.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif
#include <unistd.h>

namespace knitting_shared_memory {

constexpr size_t CACHE_LINE_SIZE = 64;

// Owns the OS resources behind one V8 SharedArrayBuffer. The JavaScript object
// keeps the V8 backing store alive; when it is collected, this mapping is
// unmapped and the fd is closed.
struct SharedMapping {
  int fd = -1;
};

size_t AlignUp(size_t value, size_t alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

int CreateSharedMemoryFd(const char* name) {
#ifdef __linux__
  return static_cast<int>(syscall(SYS_memfd_create, name, 0));
#else
  (void)name;
  static std::atomic<unsigned long> counter{0};
  char shm_name[128];

  for (int attempt = 0; attempt < 16; attempt++) {
    unsigned long next = counter.fetch_add(1);
    std::snprintf(
      shm_name,
      sizeof(shm_name),
      "/knit_n_%05lx_%06lx_%02d",
      static_cast<unsigned long>(getpid()) & 0xfffffUL,
      next & 0xffffffUL,
      attempt
    );

    int fd = shm_open(shm_name, O_CREAT | O_EXCL | O_RDWR, 0600);
    if (fd >= 0) {
      shm_unlink(shm_name);
      return fd;
    }

    if (errno != EEXIST) return -1;
  }

  errno = EEXIST;
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

void MappingDeleter(void* data, size_t length, void* deleter_data) {
  if (data != nullptr && length > 0) {
    munmap(data, length);
  }

  SharedMapping* mapping = static_cast<SharedMapping*>(deleter_data);
  if (mapping != nullptr) {
    if (mapping->fd >= 0) close(mapping->fd);
    delete mapping;
  }
}

void SetValue(
  v8::Isolate* isolate,
  v8::Local<v8::Context> context,
  v8::Local<v8::Object> object,
  const char* key,
  v8::Local<v8::Value> value
) {
  object->Set(
    context,
    v8::String::NewFromUtf8(isolate, key).ToLocalChecked(),
    value
  ).Check();
}

void ReturnMappedRegion(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  int fd,
  size_t size
) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  void* mapped = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (mapped == MAP_FAILED) {
    int saved = errno;
    close(fd);
    ThrowErrno(isolate, "mmap failed", saved);
    return;
  }

  auto* mapping = new SharedMapping();
  mapping->fd = fd;

  auto backing = v8::SharedArrayBuffer::NewBackingStore(
    mapped,
    size,
    MappingDeleter,
    mapping
  );
  auto shared = std::shared_ptr<v8::BackingStore>(std::move(backing));
  v8::Local<v8::SharedArrayBuffer> sab =
    v8::SharedArrayBuffer::New(isolate, shared);

  v8::Local<v8::Object> out = v8::Object::New(isolate);
  SetValue(isolate, context, out, "sab", sab);
  SetValue(isolate, context, out, "fd", v8::Integer::New(isolate, fd));
  SetValue(
    isolate,
    context,
    out,
    "size",
    v8::Number::New(isolate, static_cast<double>(size))
  );
  SetValue(
    isolate,
    context,
    out,
    "baseAddressMod64",
    v8::Integer::New(
      isolate,
      static_cast<int>(reinterpret_cast<uintptr_t>(mapped) % CACHE_LINE_SIZE)
    )
  );

  args.GetReturnValue().Set(out);
}

void CreateSharedMemory(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() < 1 || !args[0]->IsNumber()) {
    ThrowType(isolate, "createSharedMemory(size) requires size");
    return;
  }

  v8::Maybe<int64_t> maybe_size = args[0]->IntegerValue(context);
  if (maybe_size.IsNothing() || maybe_size.FromJust() <= 0) {
    ThrowRange(isolate, "size must be positive");
    return;
  }

  size_t size = AlignUp(static_cast<size_t>(maybe_size.FromJust()), CACHE_LINE_SIZE);
  int fd = CreateSharedMemoryFd("knitting_shared_memory");
  if (fd == -1) {
    ThrowErrno(isolate, "shared memory fd create failed");
    return;
  }

  if (ftruncate(fd, static_cast<off_t>(size)) == -1) {
    int saved = errno;
    close(fd);
    ThrowErrno(isolate, "ftruncate failed", saved);
    return;
  }

  ReturnMappedRegion(args, fd, size);
}

void MapSharedMemory(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() < 2 || !args[0]->IsNumber() || !args[1]->IsNumber()) {
    ThrowType(isolate, "mapSharedMemory(fd, size) requires fd and size");
    return;
  }

  v8::Maybe<int32_t> maybe_fd = args[0]->Int32Value(context);
  v8::Maybe<int64_t> maybe_size = args[1]->IntegerValue(context);
  if (
    maybe_fd.IsNothing() ||
    maybe_size.IsNothing() ||
    maybe_fd.FromJust() < 0 ||
    maybe_size.FromJust() <= 0
  ) {
    ThrowRange(isolate, "fd and size must be positive");
    return;
  }

  // Duplicate so each returned SAB owns exactly one fd. The caller can keep
  // using or transferring its original descriptor independently.
  int fd = dup(maybe_fd.FromJust());
  if (fd == -1) {
    ThrowErrno(isolate, "dup(fd) failed");
    return;
  }

  size_t size = AlignUp(static_cast<size_t>(maybe_size.FromJust()), CACHE_LINE_SIZE);
  ReturnMappedRegion(args, fd, size);
}

void Initialize(v8::Local<v8::Object> exports) {
  NODE_SET_METHOD(exports, "createSharedMemory", CreateSharedMemory);
  NODE_SET_METHOD(exports, "mapSharedMemory", MapSharedMemory);
}

NODE_MODULE(NODE_GYP_MODULE_NAME, Initialize)

}  // namespace knitting_shared_memory
