// Experimental, ABI-stable shared string storage for Node, Deno and Bun.
// ASCII uses compact one-byte storage; other strings preserve every UTF-16 code unit.
#define NAPI_VERSION 9
#include <node_api.h>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <new>
#include <unordered_map>

// Deno 2.7 exposes the earlier experimental external-string entry point while
// reporting Node-API 9. Keep the module version at 9 and declare that ABI here;
// this addon requires this symbol and records whether it actually copies.
extern "C" napi_status node_api_create_external_string_utf16(
  napi_env, char16_t*, size_t, napi_finalize, void*, napi_value*, bool*);

extern "C" napi_status node_api_create_external_string_latin1(
  napi_env, char*, size_t, napi_finalize, void*, napi_value*, bool*);

namespace {
std::atomic<size_t> live_bytes{0};
std::atomic<size_t> external_adoptions{0};
std::atomic<size_t> copied_adoptions{0};
struct Characters {
  size_t length;
  bool ascii;
  std::unique_ptr<char[]> latin1;
  std::unique_ptr<char16_t[]> data;
  Characters(size_t size, bool compact) : length(size), ascii(compact) {
    if (ascii) latin1.reset(new char[size + 1]);
    else data.reset(new char16_t[size + 1]);
    live_bytes += (length + 1) * (ascii ? 1 : 2);
  }
  ~Characters() { live_bytes -= (length + 1) * (ascii ? 1 : 2); }
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
  if (!Argument(env, info, text)) return Fail(env, "Expected a string");
  napi_valuetype type;
  if (!Check(env, napi_typeof(env, text, &type))) return nullptr;
  if (type != napi_string) return Fail(env, "Expected a string");
  size_t length = 0;
  if (!Check(env, napi_get_value_string_utf16(env, text, nullptr, 0, &length))) return nullptr;
  // Bound allocations and keep length arithmetic representable.
  if (length > 32 * 1024 * 1024) return Fail(env, "Native string exceeds 32 Mi code units");
  try {
    // Reject common non-ASCII inputs with a bounded prefix check.
    // An ASCII prefix alone is never sufficient to select compact storage.
    char16_t prefix[65];
    size_t prefix_length = 0;
    if (!Check(env, napi_get_value_string_utf16(env, text, prefix, 65, &prefix_length))) return nullptr;
    bool ascii = true;
    for (size_t i = 0; i < prefix_length; ++i) {
      if (prefix[i] > 0x7f) { ascii = false; break; }
    }
    auto characters = std::make_shared<Characters>(length, ascii);
    size_t written = 0;
    if (ascii) {
      // Copy ASCII directly without computing UTF-8 length in a separate pass.
      // Extraction may truncate non-ASCII text; accept only a full ASCII copy.
      if (!Check(env, napi_get_value_string_utf8(env, text, characters->latin1.get(), length + 1, &written))) return nullptr;
      uint64_t high_bits = 0;
      size_t i = 0;
      for (; i + sizeof(uint64_t) <= written; i += sizeof(uint64_t)) {
        uint64_t word;
        std::memcpy(&word, characters->latin1.get() + i, sizeof(word));
        high_bits |= word;
      }
      for (; i < written; ++i) high_bits |= static_cast<unsigned char>(characters->latin1[i]);
      ascii = written == length && (high_bits & UINT64_C(0x8080808080808080)) == 0;
      if (!ascii) {
        characters.reset();
        characters = std::make_shared<Characters>(length, false);
      }
    }
    if (!ascii) {
      if (!Check(env, napi_get_value_string_utf16(env, text, characters->data.get(), length + 1, &written))) return nullptr;
    }
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
napi_value Clone(napi_env env, napi_callback_info info) {
  auto characters = Lookup(env, info);
  if (!characters) return nullptr;
  uint64_t token;
  try {
    std::lock_guard<std::mutex> lock(mutex);
    if (next_token == 0) return Fail(env, "String token space exhausted");
    token = next_token++;
    entries.emplace(token, Entry{env, std::move(characters)});
  } catch (const std::bad_alloc&) {
    napi_throw_error(env, nullptr, "Native string owner allocation failed"); return nullptr;
  }
  napi_value result;
  if (!Check(env, napi_create_bigint_uint64(env, token, &result))) {
    std::lock_guard<std::mutex> lock(mutex);
    entries.erase(token);
    return nullptr;
  }
  return result;
}
napi_value Describe(napi_env env, napi_callback_info info) {
  auto characters = Lookup(env, info);
  if (!characters) return nullptr;
  napi_value result;
  napi_value length, byte_length;
  if (!Check(env, napi_create_object(env, &result)) ||
      !Check(env, napi_create_double(env, characters->length, &length)) ||
      !Check(env, napi_create_double(env, characters->length * (characters->ascii ? 1 : 2), &byte_length)) ||
      !Check(env, napi_set_named_property(env, result, "length", length)) ||
      !Check(env, napi_set_named_property(env, result, "byteLength", byte_length))) return nullptr;
  return result;
}
// No env calls here: finalization may run during GC or environment teardown.
void Finalize(napi_env, void*, void* hint) {
  delete static_cast<std::shared_ptr<const Characters>*>(hint);
}
napi_value Adopt(napi_env env, napi_callback_info info) {
  auto characters = Lookup(env, info);
  if (!characters) return nullptr;
  if (characters->length == 0) {
    napi_value empty;
    return Check(env, napi_create_string_latin1(env, "", 0, &empty)) ? empty : nullptr;
  }
  auto* owner = new (std::nothrow) std::shared_ptr<const Characters>(characters);
  if (!owner) { napi_throw_error(env, nullptr, "Native string owner allocation failed"); return nullptr; }
  napi_value result;
  bool copied = false;
  // Success transfers owner to the finalizer, including synchronous copy fallback.
  const auto status = characters->ascii
    ? node_api_create_external_string_latin1(env, characters->latin1.get(),
        characters->length, Finalize, owner, &result, &copied)
    : node_api_create_external_string_utf16(env, characters->data.get(),
        characters->length, Finalize, owner, &result, &copied);
  if (!Check(env, status)) { delete owner; return nullptr; }
  if (copied) ++copied_adoptions; else ++external_adoptions;
  return result;
}
napi_value Copy(napi_env env, napi_callback_info info) {
  auto characters = Lookup(env, info);
  if (!characters) return nullptr;
  napi_value result;
  const auto status = characters->ascii
    ? napi_create_string_latin1(env, characters->latin1.get(), characters->length, &result)
    : napi_create_string_utf16(env, characters->data.get(), characters->length, &result);
  if (!Check(env, status)) return nullptr;
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
  {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto it = entries.begin(); it != entries.end();) {
      if (it->second.producer == environment->env) {
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
    {"clone", nullptr, Clone, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"describe", nullptr, Describe, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"retain", nullptr, Retain, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"adopt", nullptr, Adopt, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"copy", nullptr, Copy, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"release", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stats", nullptr, Stats, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  return Check(env, napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods)) ? exports : nullptr;
}
NAPI_MODULE(knitting_string_reference, Initialize)
}  // namespace
