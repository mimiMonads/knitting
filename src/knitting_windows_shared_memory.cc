#if !defined(_WIN32)
#error "knitting_windows_shared_memory.cc only supports Windows."
#endif

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>

namespace {

constexpr uint32_t MODE_CREATE = 1;
constexpr uint32_t MODE_OPEN = 2;
constexpr size_t CACHE_LINE_SIZE = 64;

struct KnittingWindowsSharedMemory {
  void* address;
  uintptr_t handle;
  uint64_t size;
  uint32_t base_address_mod64;
  uint32_t reserved;
};

static_assert(sizeof(KnittingWindowsSharedMemory) == 32);

bool HasName(const wchar_t* name) {
  return name != nullptr && name[0] != L'\0';
}

uint32_t LastErrorOrInvalidParameter() {
  DWORD error = GetLastError();
  return error == ERROR_SUCCESS ? ERROR_INVALID_PARAMETER : error;
}

uint32_t FillMapping(
  HANDLE handle,
  uint64_t size,
  KnittingWindowsSharedMemory* out
) {
  if (handle == nullptr || out == nullptr || size == 0) {
    if (handle != nullptr) CloseHandle(handle);
    return ERROR_INVALID_PARAMETER;
  }

  void* address = MapViewOfFile(
    handle,
    FILE_MAP_ALL_ACCESS,
    0,
    0,
    static_cast<SIZE_T>(size)
  );
  if (address == nullptr) {
    DWORD error = GetLastError();
    CloseHandle(handle);
    return error == ERROR_SUCCESS ? ERROR_INVALID_PARAMETER : error;
  }

  out->address = address;
  out->handle = reinterpret_cast<uintptr_t>(handle);
  out->size = size;
  out->base_address_mod64 =
    static_cast<uint32_t>(reinterpret_cast<uintptr_t>(address) % CACHE_LINE_SIZE);
  out->reserved = 0;
  return ERROR_SUCCESS;
}

}  // namespace

extern "C" __declspec(dllexport) uint32_t
knitting_windows_create_shared_memory(
  uint64_t size,
  const wchar_t* name,
  uint32_t mode,
  KnittingWindowsSharedMemory* out
) {
  if (!HasName(name) || size == 0 || out == nullptr) {
    return ERROR_INVALID_PARAMETER;
  }

  HANDLE handle = nullptr;
  if (mode == MODE_OPEN) {
    handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
    if (handle == nullptr) return LastErrorOrInvalidParameter();
  } else if (mode == MODE_CREATE) {
    handle = CreateFileMappingW(
      INVALID_HANDLE_VALUE,
      nullptr,
      PAGE_READWRITE,
      static_cast<DWORD>(size >> 32),
      static_cast<DWORD>(size & 0xffffffffULL),
      name
    );
    if (handle == nullptr) return LastErrorOrInvalidParameter();
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
      CloseHandle(handle);
      return ERROR_ALREADY_EXISTS;
    }
  } else {
    return ERROR_INVALID_PARAMETER;
  }

  return FillMapping(handle, size, out);
}

extern "C" __declspec(dllexport) uint32_t
knitting_windows_map_shared_memory(
  uintptr_t handle_value,
  uint64_t size,
  const wchar_t* name,
  KnittingWindowsSharedMemory* out
) {
  HANDLE handle = nullptr;
  if (HasName(name)) {
    handle = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
    if (handle == nullptr) return LastErrorOrInvalidParameter();
  } else if (handle_value != 0) {
    BOOL ok = DuplicateHandle(
      GetCurrentProcess(),
      reinterpret_cast<HANDLE>(handle_value),
      GetCurrentProcess(),
      &handle,
      0,
      FALSE,
      DUPLICATE_SAME_ACCESS
    );
    if (!ok) return LastErrorOrInvalidParameter();
  } else {
    return ERROR_INVALID_PARAMETER;
  }

  return FillMapping(handle, size, out);
}

extern "C" __declspec(dllexport) uint32_t
knitting_windows_close_shared_memory(KnittingWindowsSharedMemory* mapping) {
  if (mapping == nullptr) return ERROR_INVALID_PARAMETER;

  uint32_t result = ERROR_SUCCESS;
  if (mapping->address != nullptr && !UnmapViewOfFile(mapping->address)) {
    result = LastErrorOrInvalidParameter();
  }

  if (mapping->handle != 0) {
    HANDLE handle = reinterpret_cast<HANDLE>(mapping->handle);
    if (!CloseHandle(handle) && result == ERROR_SUCCESS) {
      result = LastErrorOrInvalidParameter();
    }
  }

  mapping->address = nullptr;
  mapping->handle = 0;
  mapping->size = 0;
  mapping->base_address_mod64 = 0;
  mapping->reserved = 0;
  return result;
}
