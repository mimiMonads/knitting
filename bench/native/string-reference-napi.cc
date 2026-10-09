// Benchmark-only, ABI-stable Node-API backend for Node, Deno and Bun.
// UTF-16 preserves every JS code unit and requires no speculative ASCII scan.
#define NAPI_VERSION 9
#include <node_api.h>
#include <atomic>
#include <cstdint>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <unordered_map>
#include <vector>

// Deno 2.7 exposes the earlier experimental external-string entry point while
// reporting Node-API 9. Keep the module version at 9 and declare that ABI here;
// the benchmark requires this symbol and records whether it actually copies.
extern "C" napi_status node_api_create_external_string_utf16(
  napi_env, char16_t*, size_t, napi_finalize, void*, napi_value*, bool*);

namespace {
std::atomic<size_t> live_bytes{0};
std::atomic<size_t> external_adoptions{0};
std::atomic<size_t> copied_adoptions{0};
struct Characters {
  size_t length;
  std::unique_ptr<char16_t[]> data;
  explicit Characters(size_t size) : length(size), data(new char16_t[size + 1]) {
    live_bytes += (length + 1) * sizeof(char16_t);
  }
  ~Characters() { live_bytes -= (length + 1) * sizeof(char16_t); }
};
struct Entry {
  napi_env producer;
  std::shared_ptr<const Characters> characters;
};
struct Environment { napi_env env; };
std::mutex mutex;
uint64_t next_token = 1;
std::unordered_map<uint64_t, Entry> entries;

bool Check(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  bool pending = false;
  napi_is_exception_pending(env, &pending);
  if (!pending) napi_throw_error(env, nullptr, "String native operation failed");
  return false;
}
napi_value Fail(napi_env env, const char* message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}
bool Argument(napi_env env, napi_callback_info info, napi_value& argument) {
  size_t argc = 1;
  return Check(env, napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr)) && argc == 1;
}
bool Token(napi_env env, napi_callback_info info, uint64_t& token) {
  napi_value argument;
  if (!Argument(env, info, argument)) { Fail(env, "Expected a bigint token"); return false; }
  napi_valuetype type;
  if (!Check(env, napi_typeof(env, argument, &type))) return false;
  if (type != napi_bigint) { Fail(env, "Expected a bigint token"); return false; }
  bool lossless = false;
  if (!Check(env, napi_get_value_bigint_uint64(env, argument, &token, &lossless))) return false;
  if (!lossless || token == 0) { Fail(env, "Invalid token"); return false; }
  return true;
}
napi_value Retain(napi_env env, napi_callback_info info) {
  napi_value text;
  if (!Argument(env, info, text)) return Fail(env, "Expected a nonempty string");
  napi_valuetype type;
  if (!Check(env, napi_typeof(env, text, &type))) return nullptr;
  if (type != napi_string) return Fail(env, "Expected a nonempty string");
  size_t length = 0;
  if (!Check(env, napi_get_value_string_utf16(env, text, nullptr, 0, &length))) return nullptr;
  if (length == 0) return Fail(env, "Expected a nonempty string");
  // Keep this experiment bounded even if called outside the harness.
  if (length > 32 * 1024 * 1024) return Fail(env, "Native string exceeds 32 Mi code units");
  try {
    auto characters = std::make_shared<Characters>(length);
    size_t written = 0;
    if (!Check(env, napi_get_value_string_utf16(env, text, characters->data.get(), length + 1, &written))) return nullptr;
    if (written != length) return Fail(env, "Incomplete character copy");
    uint64_t token;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (next_token == 0) return Fail(env, "String token space exhausted");
      token = next_token++;
      entries.emplace(token, Entry{env, std::move(characters)});
    }
    napi_value result;
    if (!Check(env, napi_create_bigint_uint64(env, token, &result))) {
      std::lock_guard<std::mutex> lock(mutex);
      entries.erase(token);
      return nullptr;
    }
    return result;
  } catch (const std::bad_alloc&) {
    napi_throw_error(env, nullptr, "Native string allocation failed"); return nullptr;
  }
}
std::shared_ptr<const Characters> Lookup(napi_env env, napi_callback_info info) {
  uint64_t token;
  if (!Token(env, info, token)) return {};
  std::shared_ptr<const Characters> characters;
  {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = entries.find(token);
    if (it != entries.end()) characters = it->second.characters;
  }
  if (!characters) Fail(env, "Released or unknown string token");
  return characters;
}
// No env calls here: finalization may run during GC or environment teardown.
void Finalize(napi_env, void*, void* hint) {
  delete static_cast<std::shared_ptr<const Characters>*>(hint);
}
napi_value Adopt(napi_env env, napi_callback_info info) {
  auto characters = Lookup(env, info);
  if (!characters) return nullptr;
  auto* owner = new (std::nothrow) std::shared_ptr<const Characters>(characters);
  if (!owner) { napi_throw_error(env, nullptr, "Native string owner allocation failed"); return nullptr; }
  napi_value result;
  bool copied = false;
  // Success transfers owner to the finalizer, including synchronous copy fallback.
  const auto status = node_api_create_external_string_utf16(env,
    characters->data.get(), characters->length,
    Finalize, owner, &result, &copied);
  if (!Check(env, status)) { delete owner; return nullptr; }
  if (copied) ++copied_adoptions; else ++external_adoptions;
  return result;
}
napi_value Copy(napi_env env, napi_callback_info info) {
  auto characters = Lookup(env, info);
  if (!characters) return nullptr;
  napi_value result;
  if (!Check(env, napi_create_string_utf16(env, characters->data.get(), characters->length, &result))) return nullptr;
  ++copied_adoptions;
  return result;
}
napi_value Release(napi_env env, napi_callback_info info) {
  uint64_t token;
  if (!Token(env, info, token)) return nullptr;
  std::shared_ptr<const Characters> released;
  {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = entries.find(token);
    if (it != entries.end()) {
      released = std::move(it->second.characters);
      entries.erase(it);
    }
  }
  napi_value result;
  if (!Check(env, napi_get_boolean(env, static_cast<bool>(released), &result))) return nullptr;
  return result;
}
void Cleanup(void* data) {
  std::unique_ptr<Environment> environment(static_cast<Environment*>(data));
  std::vector<std::shared_ptr<const Characters>> released;
  {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto it = entries.begin(); it != entries.end();) {
      if (it->second.producer == environment->env) {
        released.push_back(std::move(it->second.characters));
        it = entries.erase(it);
      } else ++it;
    }
  }
}
napi_value Stats(napi_env env, napi_callback_info) {
  napi_value result;
  if (!Check(env, napi_create_object(env, &result))) return nullptr;
  size_t count;
  { std::lock_guard<std::mutex> lock(mutex); count = entries.size(); }
  auto set = [&](const char* key, size_t value) {
    napi_value number;
    return Check(env, napi_create_double(env, value, &number)) &&
      Check(env, napi_set_named_property(env, result, key, number));
  };
  if (!set("entries", count) || !set("liveBytes", live_bytes.load()) ||
      !set("externalAdoptions", external_adoptions.load()) ||
      !set("copiedAdoptions", copied_adoptions.load())) return nullptr;
  return result;
}
napi_value Initialize(napi_env env, napi_value exports) {
  auto environment = std::make_unique<Environment>(Environment{env});
  if (!Check(env, napi_add_env_cleanup_hook(env, Cleanup, environment.get()))) return nullptr;
  environment.release();
  const napi_property_descriptor methods[] = {
    {"retain", nullptr, Retain, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"adopt", nullptr, Adopt, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"copy", nullptr, Copy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return Check(env, napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods)) ? exports : nullptr;
}
NAPI_MODULE(knitting_string_reference_napi, Initialize)
}  // namespace
