// Benchmark-only Node/V8 prototype. No raw pointers or writable aliases escape.
#include <node.h>
#include <v8.h>
#include <atomic>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace {
std::atomic<size_t> live_bytes{0};
std::atomic<size_t> external_adoptions{0};
std::atomic<size_t> copied_adoptions{0};
struct Characters {
  bool one_byte;
  size_t length;
  std::unique_ptr<uint8_t[]> latin1;
  std::unique_ptr<uint16_t[]> utf16;
  Characters(bool one, size_t len) : one_byte(one), length(len) {
    if (one) latin1.reset(new uint8_t[len]); else utf16.reset(new uint16_t[len]);
    live_bytes += len * (one ? 1 : 2);
  }
  ~Characters() { live_bytes -= length * (one_byte ? 1 : 2); }
};
struct Entry {
  v8::Isolate* producer;
  std::shared_ptr<const Characters> characters;
};
std::mutex mutex;
uint64_t next_token = 1;
std::unordered_map<uint64_t, Entry> entries;

// The resource owns the memory independently of the sender's registry hold.
class Latin1Resource final : public v8::String::ExternalOneByteStringResource {
  std::shared_ptr<const Characters> characters_;
 public:
  explicit Latin1Resource(std::shared_ptr<const Characters> c) : characters_(std::move(c)) {}
  const char* data() const override {
    return reinterpret_cast<const char*>(characters_->latin1.get());
  }
  size_t length() const override { return characters_->length; }
};
class Utf16Resource final : public v8::String::ExternalStringResource {
  std::shared_ptr<const Characters> characters_;
 public:
  explicit Utf16Resource(std::shared_ptr<const Characters> c) : characters_(std::move(c)) {}
  const uint16_t* data() const override { return characters_->utf16.get(); }
  size_t length() const override { return characters_->length; }
};
void Throw(v8::Isolate* isolate, const char* message) {
  isolate->ThrowException(v8::Exception::TypeError(
    v8::String::NewFromUtf8(isolate, message).ToLocalChecked()));
}
bool Token(const v8::FunctionCallbackInfo<v8::Value>& args, uint64_t& token) {
  if (args.Length() < 1 || !args[0]->IsBigInt()) {
    Throw(args.GetIsolate(), "Expected a bigint token"); return false;
  }
  bool lossless;
  token = args[0].As<v8::BigInt>()->Uint64Value(&lossless);
  if (!lossless || token == 0) {
    Throw(args.GetIsolate(), "Invalid token"); return false;
  }
  return true;
}
void Retain(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto* isolate = args.GetIsolate();
  if (args.Length() < 1 || !args[0]->IsString() || args[0].As<v8::String>()->Length() == 0) {
    Throw(isolate, "Expected a nonempty string"); return;
  }
  auto text = args[0].As<v8::String>();
  // IsOneByte avoids an extra scan; two-byte Latin-1 remains two-byte here.
  auto c = std::make_shared<Characters>(text->IsOneByte(), text->Length());
#if NODE_MAJOR_VERSION >= 24
  if (c->one_byte) text->WriteOneByteV2(isolate, 0, c->length, c->latin1.get());
  else text->WriteV2(isolate, 0, c->length, c->utf16.get());
#else
  if (c->one_byte) text->WriteOneByte(isolate, c->latin1.get(), 0, c->length, v8::String::NO_NULL_TERMINATION);
  else text->Write(isolate, c->utf16.get(), 0, c->length, v8::String::NO_NULL_TERMINATION);
#endif
  uint64_t token;
  {
    std::lock_guard<std::mutex> lock(mutex);
    token = next_token++;
    entries.emplace(token, Entry{isolate, std::move(c)});
  }
  args.GetReturnValue().Set(v8::BigInt::NewFromUnsigned(isolate, token));
}
std::shared_ptr<const Characters> Lookup(const v8::FunctionCallbackInfo<v8::Value>& args) {
  uint64_t token;
  if (!Token(args, token)) return {};
  std::shared_ptr<const Characters> c;
  {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = entries.find(token);
    if (it != entries.end()) c = it->second.characters;
  }
  if (!c) Throw(args.GetIsolate(), "Released or unknown string token");
  return c;
}
void Adopt(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto c = Lookup(args);
  if (!c) return;
  auto* isolate = args.GetIsolate();
  v8::Local<v8::String> text;
  if (c->one_byte) {
    auto* resource = new Latin1Resource(c);
    if (!v8::String::NewExternalOneByte(isolate, resource).ToLocal(&text)) {
      delete resource; return;
    }
  } else {
    auto* resource = new Utf16Resource(c);
    if (!v8::String::NewExternalTwoByte(isolate, resource).ToLocal(&text)) {
      delete resource; return;
    }
  }
  ++external_adoptions;
  args.GetReturnValue().Set(text);
}
// Control arm: same character storage, but copy into the receiver's V8 heap.
void Copy(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto c = Lookup(args);
  if (!c) return;
  v8::Local<v8::String> text;
  auto result = c->one_byte
    ? v8::String::NewFromOneByte(args.GetIsolate(), c->latin1.get(), v8::NewStringType::kNormal, c->length)
    : v8::String::NewFromTwoByte(args.GetIsolate(), c->utf16.get(), v8::NewStringType::kNormal, c->length);
  if (result.ToLocal(&text)) {
    ++copied_adoptions;
    args.GetReturnValue().Set(text);
  }
}
void Release(const v8::FunctionCallbackInfo<v8::Value>& args) {
  uint64_t token;
  if (!Token(args, token)) return;
  std::shared_ptr<const Characters> released;
  {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = entries.find(token);
    if (it != entries.end()) {
      released = std::move(it->second.characters);
      entries.erase(it);
    }
  }
  args.GetReturnValue().Set(static_cast<bool>(released));
}
void Stats(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto* isolate = args.GetIsolate();
  auto result = v8::Object::New(isolate);
  size_t count;
  { std::lock_guard<std::mutex> lock(mutex); count = entries.size(); }
  auto context = isolate->GetCurrentContext();
  result->Set(context, v8::String::NewFromUtf8Literal(isolate, "entries"),
    v8::Number::New(isolate, count)).Check();
  result->Set(context, v8::String::NewFromUtf8Literal(isolate, "liveBytes"),
    v8::Number::New(isolate, live_bytes.load())).Check();
  result->Set(context, v8::String::NewFromUtf8Literal(isolate, "externalAdoptions"),
    v8::Number::New(isolate, external_adoptions.load())).Check();
  result->Set(context, v8::String::NewFromUtf8Literal(isolate, "copiedAdoptions"),
    v8::Number::New(isolate, copied_adoptions.load())).Check();
  args.GetReturnValue().Set(result);
}
void IsExternal(const v8::FunctionCallbackInfo<v8::Value>& args) {
  args.GetReturnValue().Set(args.Length() > 0 && args[0]->IsString() &&
    args[0].As<v8::String>()->IsExternal());
}
void Cleanup(void* data) {
  std::vector<std::shared_ptr<const Characters>> released;
  {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto it = entries.begin(); it != entries.end();) {
      if (it->second.producer == data) {
        released.push_back(std::move(it->second.characters));
        it = entries.erase(it);
      } else ++it;
    }
  }
}
void Initialize(v8::Local<v8::Object> exports, v8::Local<v8::Value>, v8::Local<v8::Context>) {
  node::AddEnvironmentCleanupHook(exports->GetIsolate(), Cleanup, exports->GetIsolate());
  NODE_SET_METHOD(exports, "retain", Retain);
  NODE_SET_METHOD(exports, "adopt", Adopt);
  NODE_SET_METHOD(exports, "copy", Copy);
  NODE_SET_METHOD(exports, "release", Release);
  NODE_SET_METHOD(exports, "stats", Stats);
  NODE_SET_METHOD(exports, "isExternal", IsExternal);
}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)
}  // namespace
