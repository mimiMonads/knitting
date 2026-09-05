#include <node.h>
#include <uv.h>
#include <v8.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <unordered_set>

namespace knitting_doorbell {

struct CompletionDoorbell {
  uv_async_t async;
  v8::Isolate* isolate;
  v8::Global<v8::Context> context;
  v8::Global<v8::Function> callback;
  std::atomic<bool> closed{false};
};

std::mutex doorbells_mutex;
std::unordered_set<CompletionDoorbell*> doorbells;

void ThrowType(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::TypeError(
    v8::String::NewFromUtf8(isolate, message).ToLocalChecked()
  ));
}

void ThrowUv(v8::Isolate* isolate, const char* message, int status) {
  const char* uv_message = uv_strerror(status);
  v8::Local<v8::String> detail = v8::String::NewFromUtf8(
    isolate,
    uv_message == nullptr ? message : uv_message
  ).ToLocalChecked();
  isolate->ThrowException(v8::Exception::Error(detail));
}

bool ReadDoorbellPointer(
  const v8::FunctionCallbackInfo<v8::Value>& args,
  CompletionDoorbell** out
) {
  v8::Isolate* isolate = args.GetIsolate();
  if (args.Length() < 1 || !args[0]->IsBigInt()) {
    ThrowType(isolate, "completion doorbell pointer must be a bigint");
    return false;
  }

  bool lossless = false;
  uint64_t raw = args[0].As<v8::BigInt>()->Uint64Value(&lossless);
  if (!lossless || raw == 0) {
    ThrowType(isolate, "completion doorbell pointer must be non-zero");
    return false;
  }

  *out = reinterpret_cast<CompletionDoorbell*>(
    static_cast<uintptr_t>(raw)
  );
  return true;
}

void DisposeDoorbell(uv_handle_t* handle) {
  auto* doorbell = static_cast<CompletionDoorbell*>(handle->data);
  if (doorbell == nullptr) return;
  doorbell->callback.Reset();
  doorbell->context.Reset();
  delete doorbell;
}

void InvokeDoorbell(uv_async_t* async) {
  auto* doorbell = static_cast<CompletionDoorbell*>(async->data);
  if (doorbell == nullptr || doorbell->closed.load(std::memory_order_acquire)) {
    return;
  }

  v8::Isolate* isolate = doorbell->isolate;
  v8::HandleScope scope(isolate);
  v8::Local<v8::Context> context = doorbell->context.Get(isolate);
  v8::Local<v8::Function> callback = doorbell->callback.Get(isolate);
  if (context.IsEmpty() || callback.IsEmpty()) return;

  v8::Context::Scope context_scope(context);
  v8::TryCatch try_catch(isolate);
  // This is called by Node's event-loop thread, not the worker that rang the
  // handle. Do not let a user callback exception escape into libuv.
  v8::MaybeLocal<v8::Value> call_result = callback->Call(
    context,
    v8::Undefined(isolate),
    0,
    nullptr
  );
  (void)call_result;
}

void CleanupDoorbell(void* data);

void CloseDoorbell(CompletionDoorbell* doorbell, bool remove_cleanup_hook) {
  bool should_close = false;
  {
    std::lock_guard<std::mutex> lock(doorbells_mutex);
    auto found = doorbells.find(doorbell);
    if (found == doorbells.end()) return;
    doorbell->closed.store(true, std::memory_order_release);
    doorbells.erase(found);
    should_close = true;
  }

  if (remove_cleanup_hook) {
    node::RemoveEnvironmentCleanupHook(
      doorbell->isolate,
      CleanupDoorbell,
      doorbell
    );
  }
  if (should_close && !uv_is_closing(reinterpret_cast<uv_handle_t*>(&doorbell->async))) {
    uv_close(reinterpret_cast<uv_handle_t*>(&doorbell->async), DisposeDoorbell);
  }
}

void CleanupDoorbell(void* data) {
  CloseDoorbell(static_cast<CompletionDoorbell*>(data), false);
}

void CreateCompletionDoorbell(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (args.Length() < 1 || !args[0]->IsFunction()) {
    ThrowType(isolate, "createCompletionDoorbell(callback) requires a function");
    return;
  }

  uv_loop_t* loop = node::GetCurrentEventLoop(isolate);
  if (loop == nullptr) {
    ThrowUv(isolate, "Node event loop is unavailable", UV_EINVAL);
    return;
  }

  auto* doorbell = new CompletionDoorbell();
  doorbell->isolate = isolate;
  doorbell->async.data = doorbell;
  const int status = uv_async_init(loop, &doorbell->async, InvokeDoorbell);
  if (status != 0) {
    delete doorbell;
    ThrowUv(isolate, "uv_async_init failed", status);
    return;
  }

  doorbell->context.Reset(isolate, isolate->GetCurrentContext());
  doorbell->callback.Reset(isolate, args[0].As<v8::Function>());
  {
    std::lock_guard<std::mutex> lock(doorbells_mutex);
    doorbells.insert(doorbell);
  }
  node::AddEnvironmentCleanupHook(isolate, CleanupDoorbell, doorbell);

  args.GetReturnValue().Set(v8::BigInt::NewFromUnsigned(
    isolate,
    static_cast<uint64_t>(reinterpret_cast<uintptr_t>(doorbell))
  ));
}

void RingCompletionDoorbell(const v8::FunctionCallbackInfo<v8::Value>& args) {
  CompletionDoorbell* doorbell = nullptr;
  if (!ReadDoorbellPointer(args, &doorbell)) return;

  int status = UV_EINVAL;
  {
    // The registry guards a host close racing a worker-thread ring. Holding it
    // through uv_async_send is safe: the send is non-blocking and coalesced.
    std::lock_guard<std::mutex> lock(doorbells_mutex);
    if (
      doorbells.contains(doorbell) &&
      !doorbell->closed.load(std::memory_order_acquire)
    ) {
      status = uv_async_send(&doorbell->async);
    }
  }
  args.GetReturnValue().Set(status == 0);
}

void UnrefCompletionDoorbell(const v8::FunctionCallbackInfo<v8::Value>& args) {
  CompletionDoorbell* doorbell = nullptr;
  if (!ReadDoorbellPointer(args, &doorbell)) return;

  bool found = false;
  {
    std::lock_guard<std::mutex> lock(doorbells_mutex);
    if (doorbells.contains(doorbell)) {
      uv_unref(reinterpret_cast<uv_handle_t*>(&doorbell->async));
      found = true;
    }
  }
  args.GetReturnValue().Set(found);
}

void CloseCompletionDoorbell(const v8::FunctionCallbackInfo<v8::Value>& args) {
  CompletionDoorbell* doorbell = nullptr;
  if (!ReadDoorbellPointer(args, &doorbell)) return;

  bool found = false;
  {
    std::lock_guard<std::mutex> lock(doorbells_mutex);
    found = doorbells.contains(doorbell);
  }
  if (found) CloseDoorbell(doorbell, true);
  args.GetReturnValue().Set(found);
}

void Initialize(
  v8::Local<v8::Object> exports,
  v8::Local<v8::Value>,
  v8::Local<v8::Context>
) {
  NODE_SET_METHOD(exports, "createCompletionDoorbell", CreateCompletionDoorbell);
  NODE_SET_METHOD(exports, "ringCompletionDoorbell", RingCompletionDoorbell);
  NODE_SET_METHOD(exports, "unrefCompletionDoorbell", UnrefCompletionDoorbell);
  NODE_SET_METHOD(exports, "closeCompletionDoorbell", CloseCompletionDoorbell);
}

NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)

}  // namespace knitting_doorbell
