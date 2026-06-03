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
  if (!buffer->IsDetachable()) {
    args.GetReturnValue().Set(false);
    return;
  }

  v8::Maybe<bool> detached = buffer->Detach(DetachKey(isolate));
  args.GetReturnValue().Set(detached.IsJust() && detached.FromJust());
}

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
}

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)

}
