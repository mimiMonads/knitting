#if !defined(__linux__) && !defined(__APPLE__) && !defined(_WIN32)
#error "knitting_buffer_pointer.cc currently supports Linux, macOS, and Windows."
#endif

#include <node.h>
#include <v8.h>

#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>

namespace knitting_buffer_pointer {

struct RetainedReference {
  v8::Isolate* isolate;
  v8::Global<v8::Value> value;
};

std::mutex retained_mutex;
uint64_t next_retained_id = 1;
std::unordered_map<uint64_t, std::unique_ptr<RetainedReference>> retained_refs;

// BackingStore is isolate-independent, unlike v8::Global<Value>.
// Consumers can co-own moved bytes while the registry keeps producer liveness.
struct RetainedBackingStore {
  std::shared_ptr<v8::BackingStore> store;
  size_t byte_offset;
  size_t byte_length;
};

std::mutex backing_mutex;
uint64_t next_backing_id = 1;
std::unordered_map<uint64_t, RetainedBackingStore> retained_backings;

void ThrowType(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::TypeError(
    v8::String::NewFromUtf8(isolate, message).ToLocalChecked()
  ));
}

v8::Local<v8::String> DetachKey(v8::Isolate* isolate) {
  return v8::String::NewFromUtf8Literal(
    isolate,
    "knitting.bufferReference.detachKey"
  );
}

bool DetachWithKey(
  v8::Local<v8::ArrayBuffer> buffer,
  v8::Local<v8::Value> key
) {
  v8::Maybe<bool> detached = buffer->Detach(key);
  return (detached.IsJust() && detached.FromJust()) || buffer->WasDetached();
}

bool DetachDefaultArrayBuffer(v8::Local<v8::ArrayBuffer> buffer) {
  if (buffer->WasDetached()) return true;
  if (!buffer->IsDetachable()) return false;
  return DetachWithKey(buffer, v8::Local<v8::Value>());
}

bool DetachKnittingArrayBuffer(
  v8::Isolate* isolate,
  v8::Local<v8::ArrayBuffer> buffer
) {
  if (buffer->WasDetached()) return true;
  if (!buffer->IsDetachable()) return false;
  if (DetachWithKey(buffer, DetachKey(isolate))) return true;
  return DetachWithKey(buffer, v8::Local<v8::Value>());
}

bool ReadPointerInfo(
  v8::Isolate* isolate,
  v8::Local<v8::Value> value,
  void** data,
  size_t* byte_length
) {
  size_t byte_offset = 0;

  if (value->IsArrayBufferView()) {
    v8::Local<v8::ArrayBufferView> view = value.As<v8::ArrayBufferView>();
    *data = view->Buffer()->Data();
    byte_offset = view->ByteOffset();
    *byte_length = view->ByteLength();
  } else if (value->IsArrayBuffer()) {
    v8::Local<v8::ArrayBuffer> buffer = value.As<v8::ArrayBuffer>();
    *data = buffer->Data();
    *byte_length = buffer->ByteLength();
  } else if (value->IsSharedArrayBuffer()) {
    v8::Local<v8::SharedArrayBuffer> buffer = value.As<v8::SharedArrayBuffer>();
    *data = buffer->Data();
    *byte_length = buffer->ByteLength();
  } else {
    ThrowType(
      isolate,
      "getPointer expects an ArrayBuffer, SharedArrayBuffer, or typed array"
    );
    return false;
  }

  *data = static_cast<uint8_t*>(*data) + byte_offset;
  return true;
}

uint64_t ReadToken(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  int index,
  const char* message
) {
  v8::Isolate* isolate = args.GetIsolate();
  if (args.Length() <= index || !args[index]->IsBigInt()) {
    ThrowType(isolate, message);
    return 0;
  }

  bool lossless = false;
  uint64_t token = args[index].As<v8::BigInt>()->Uint64Value(&lossless);
  if (token == 0) {
    ThrowType(isolate, "retained pointer token must be non-zero");
    return 0;
  }
  return token;
}

void GetPointer(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  if (args.Length() < 1) {
    ThrowType(isolate, "getPointer(buffer) requires an ArrayBuffer or view");
    return;
  }

  void* data = nullptr;
  size_t byte_length = 0;
  if (!ReadPointerInfo(isolate, args[0], &data, &byte_length)) return;

  uintptr_t address = reinterpret_cast<uintptr_t>(data);
  args.GetReturnValue().Set(
    v8::BigInt::NewFromUnsigned(isolate, static_cast<uint64_t>(address))
  );
}

void RetainPointer(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() < 1) {
    ThrowType(isolate, "retainPointer(buffer) requires an ArrayBuffer or view");
    return;
  }

  void* data = nullptr;
  size_t byte_length = 0;
  if (!ReadPointerInfo(isolate, args[0], &data, &byte_length)) return;

  auto retained = std::make_unique<RetainedReference>();
  retained->isolate = isolate;
  retained->value.Reset(isolate, args[0]);

  uint64_t token = 0;
  {
    std::lock_guard<std::mutex> lock(retained_mutex);
    token = next_retained_id++;
    if (token == 0) token = next_retained_id++;
    retained_refs.emplace(token, std::move(retained));
  }

  v8::Local<v8::Object> result = v8::Object::New(isolate);
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "pointer"),
    v8::BigInt::NewFromUnsigned(
      isolate,
      static_cast<uint64_t>(reinterpret_cast<uintptr_t>(data))
    )
  ).ToChecked();
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "byteLength"),
    v8::Number::New(isolate, static_cast<double>(byte_length))
  ).ToChecked();
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "token"),
    v8::BigInt::NewFromUnsigned(isolate, token)
  ).ToChecked();
  args.GetReturnValue().Set(result);
}

void ReleasePointer(const v8::FunctionCallbackInfo<v8::Value>& args) {
  uint64_t token = ReadToken(args, 0, "releasePointer(token) requires a bigint");
  if (token == 0) return;

  std::unique_ptr<RetainedReference> retained;
  {
    std::lock_guard<std::mutex> lock(retained_mutex);
    auto found = retained_refs.find(token);
    if (found == retained_refs.end()) {
      args.GetReturnValue().Set(false);
      return;
    }
    retained = std::move(found->second);
    retained_refs.erase(found);
  }

  retained->value.Reset();
  args.GetReturnValue().Set(true);
}

void NoopDeleter(void*, size_t, void*) {}

void WrapPointer(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() < 2 || !args[0]->IsBigInt() || !args[1]->IsNumber()) {
    ThrowType(
      isolate,
      "wrapPointer(pointer: bigint, byteLength: number) requires both arguments"
    );
    return;
  }

  bool lossless = false;
  uint64_t address = args[0].As<v8::BigInt>()->Uint64Value(&lossless);
  if (address == 0) {
    ThrowType(isolate, "wrapPointer received a null pointer");
    return;
  }

  v8::Maybe<int64_t> maybe_length = args[1]->IntegerValue(context);
  if (maybe_length.IsNothing() || maybe_length.FromJust() < 0) {
    ThrowType(isolate, "byteLength must be a non-negative integer");
    return;
  }
  size_t byte_length = static_cast<size_t>(maybe_length.FromJust());

  void* data = reinterpret_cast<void*>(static_cast<uintptr_t>(address));
  std::unique_ptr<v8::BackingStore> backing = v8::ArrayBuffer::NewBackingStore(
    data,
    byte_length,
    NoopDeleter,
    nullptr
  );
  std::shared_ptr<v8::BackingStore> shared(std::move(backing));
  v8::Local<v8::ArrayBuffer> buffer = v8::ArrayBuffer::New(isolate, shared);
  buffer->SetDetachKey(DetachKey(isolate));
  args.GetReturnValue().Set(buffer);
}

void DetachArrayBuffer(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();

  if (args.Length() < 1 || !args[0]->IsArrayBuffer()) {
    ThrowType(isolate, "detachArrayBuffer(buffer) requires an ArrayBuffer");
    return;
  }

  v8::Local<v8::ArrayBuffer> buffer = args[0].As<v8::ArrayBuffer>();
  if (buffer->WasDetached()) {
    args.GetReturnValue().Set(true);
    return;
  }
  args.GetReturnValue().Set(DetachKnittingArrayBuffer(isolate, buffer));
}

// Read the underlying ArrayBuffer + region of an ArrayBuffer or typed-array view.
// SharedArrayBuffer is rejected: it is already shareable and must not be detached.
bool ReadArrayBufferRegion(
  v8::Isolate* isolate,
  v8::Local<v8::Value> value,
  v8::Local<v8::ArrayBuffer>* buffer,
  size_t* byte_offset,
  size_t* byte_length
) {
  if (value->IsArrayBufferView()) {
    v8::Local<v8::ArrayBufferView> view = value.As<v8::ArrayBufferView>();
    *buffer = view->Buffer();
    *byte_offset = view->ByteOffset();
    *byte_length = view->ByteLength();
    return true;
  }
  if (value->IsArrayBuffer()) {
    v8::Local<v8::ArrayBuffer> ab = value.As<v8::ArrayBuffer>();
    *buffer = ab;
    *byte_offset = 0;
    *byte_length = ab->ByteLength();
    return true;
  }
  ThrowType(
    isolate,
    "retainBackingStore expects an ArrayBuffer or typed array (not a SharedArrayBuffer)"
  );
  return false;
}

// retainBackingStore(buffer) -> { pointer, byteOffset, byteLength, token }
// Registry-pins the backing store, then detaches the source for the move.
void RetainBackingStore(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();

  if (args.Length() < 1) {
    ThrowType(isolate, "retainBackingStore(buffer) requires an ArrayBuffer or view");
    return;
  }

  v8::Local<v8::ArrayBuffer> buffer;
  size_t byte_offset = 0;
  size_t byte_length = 0;
  if (!ReadArrayBufferRegion(isolate, args[0], &buffer, &byte_offset, &byte_length)) {
    return;
  }

  std::shared_ptr<v8::BackingStore> store = buffer->GetBackingStore();
  uint8_t* base = static_cast<uint8_t*>(store->Data());
  uintptr_t address = reinterpret_cast<uintptr_t>(base + byte_offset);

  // Detach only after taking the shared_ptr; ordinary JS buffers use no key.
  DetachDefaultArrayBuffer(buffer);

  uint64_t token = 0;
  {
    std::lock_guard<std::mutex> lock(backing_mutex);
    token = next_backing_id++;
    if (token == 0) token = next_backing_id++;
    retained_backings.emplace(
      token,
      RetainedBackingStore{ std::move(store), byte_offset, byte_length }
    );
  }

  v8::Local<v8::Object> result = v8::Object::New(isolate);
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "pointer"),
    v8::BigInt::NewFromUnsigned(isolate, static_cast<uint64_t>(address))
  ).ToChecked();
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "byteOffset"),
    v8::Number::New(isolate, static_cast<double>(byte_offset))
  ).ToChecked();
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "byteLength"),
    v8::Number::New(isolate, static_cast<double>(byte_length))
  ).ToChecked();
  result->Set(
    context,
    v8::String::NewFromUtf8Literal(isolate, "token"),
    v8::BigInt::NewFromUnsigned(isolate, token)
  ).ToChecked();
  args.GetReturnValue().Set(result);
}

// adoptBackingStore(token) -> ArrayBuffer
// Returns an ArrayBuffer in the caller's isolate that co-owns the registry store.
// The registry entry remains until producer release.
void AdoptBackingStore(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  uint64_t token = ReadToken(args, 0, "adoptBackingStore(token) requires a bigint");
  if (token == 0) return;

  std::shared_ptr<v8::BackingStore> store;
  {
    std::lock_guard<std::mutex> lock(backing_mutex);
    auto found = retained_backings.find(token);
    if (found == retained_backings.end()) {
      ThrowType(isolate, "adoptBackingStore: unknown or released token");
      return;
    }
    store = found->second.store;
  }

  v8::Local<v8::ArrayBuffer> buffer = v8::ArrayBuffer::New(isolate, store);
  buffer->SetDetachKey(DetachKey(isolate));
  args.GetReturnValue().Set(buffer);
}

// releaseBackingStore(token) -> boolean
// Drops the registry's reference. The store is freed only if no consumer adopted.
void ReleaseBackingStore(const v8::FunctionCallbackInfo<v8::Value>& args) {
  uint64_t token =
    ReadToken(args, 0, "releaseBackingStore(token) requires a bigint");
  if (token == 0) return;

  RetainedBackingStore released;
  bool found = false;
  {
    std::lock_guard<std::mutex> lock(backing_mutex);
    auto it = retained_backings.find(token);
    if (it != retained_backings.end()) {
      released = std::move(it->second);
      retained_backings.erase(it);
      found = true;
    }
  }
  // released.store drops here, outside the lock.
  args.GetReturnValue().Set(found);
}

// SAB transport avoids SharedArrayBuffer::New across isolates: worker teardown
// can corrupt the shared store. JS pins plus non-owning aliases keep native
// handles from outliving their isolate.

void Initialize(
  v8::Local<v8::Object> exports,
  v8::Local<v8::Value>,
  v8::Local<v8::Context>
) {
  NODE_SET_METHOD(exports, "getPointer", GetPointer);
  NODE_SET_METHOD(exports, "retainPointer", RetainPointer);
  NODE_SET_METHOD(exports, "releasePointer", ReleasePointer);
  NODE_SET_METHOD(exports, "wrapPointer", WrapPointer);
  NODE_SET_METHOD(exports, "detachArrayBuffer", DetachArrayBuffer);
  NODE_SET_METHOD(exports, "retainBackingStore", RetainBackingStore);
  NODE_SET_METHOD(exports, "adoptBackingStore", AdoptBackingStore);
  NODE_SET_METHOD(exports, "releaseBackingStore", ReleaseBackingStore);
}

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)

}
