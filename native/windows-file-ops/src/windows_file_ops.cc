#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <node_api.h>

#include <array>
#include <cstdint>
#include <new>
#include <string>
#include <utility>
#include <vector>

namespace {

constexpr const char* kErrorCode = "WINDOWS_FILE_OPS_INVALID";
constexpr std::array<char, 16> kLowerHex = {
    '0', '1', '2', '3', '4', '5', '6', '7',
    '8', '9', 'a', 'b', 'c', 'd', 'e', 'f',
};
constexpr napi_type_tag kHoldTypeTag = {
    0x0c59c605f4acee51ULL,
    0x8a8e9f2287a1c39dULL,
};

struct CapturedIdentity {
  std::string volume_serial;
  std::string file_id;
};

class ScopedHandle {
 public:
  ScopedHandle() = default;
  explicit ScopedHandle(HANDLE handle) : handle_(handle) {}
  ScopedHandle(const ScopedHandle&) = delete;
  ScopedHandle& operator=(const ScopedHandle&) = delete;

  ~ScopedHandle() { Close(); }

  HANDLE get() const { return handle_; }

  void reset(HANDLE handle) {
    Close();
    handle_ = handle;
  }

  HANDLE release() {
    const HANDLE handle = handle_;
    handle_ = INVALID_HANDLE_VALUE;
    return handle;
  }

  void Close() {
    if (handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
    }
  }

 private:
  HANDLE handle_ = INVALID_HANDLE_VALUE;
};

struct HeldHandle {
  HeldHandle(HANDLE file_value, HANDLE directory_value)
      : file_handle(file_value), directory_handle(directory_value) {}

  HANDLE file_handle = INVALID_HANDLE_VALUE;
  HANDLE directory_handle = INVALID_HANDLE_VALUE;
};

void ThrowError(napi_env env, const char* message) {
  napi_throw_error(env, kErrorCode, message);
}

void ThrowWin32Error(napi_env env, const char* operation) {
  std::string message(operation);
  message.append(" failed while accessing a Windows file.");
  ThrowError(env, message.c_str());
}

bool IsAsciiLetter(char16_t character) {
  return (character >= u'a' && character <= u'z') ||
      (character >= u'A' && character <= u'Z');
}

bool IsPathSeparator(char16_t character) {
  return character == u'\\' || character == u'/';
}

bool IsUncPath(const std::u16string& path) {
  if (path.size() < 5 || !IsPathSeparator(path[0]) ||
      !IsPathSeparator(path[1])) {
    return false;
  }

  const size_t server_start = 2;
  size_t server_end = server_start;
  while (server_end < path.size() && !IsPathSeparator(path[server_end])) {
    ++server_end;
  }
  if (server_end == server_start || server_end == path.size()) {
    return false;
  }

  const size_t share_start = server_end + 1;
  size_t share_end = share_start;
  while (share_end < path.size() && !IsPathSeparator(path[share_end])) {
    ++share_end;
  }
  return share_end != share_start;
}

bool IsAbsoluteWindowsPath(const std::u16string& path) {
  const bool is_drive_path = path.size() >= 3 && IsAsciiLetter(path[0]) &&
      path[1] == u':' && IsPathSeparator(path[2]);
  return is_drive_path || IsUncPath(path);
}

bool GetImmediateParentDirectory(
    napi_env env,
    const std::u16string& path,
    std::u16string* parent) {
  size_t path_end = path.size();
  while (path_end > 0 && IsPathSeparator(path[path_end - 1])) {
    --path_end;
  }
  if (path_end == 0) {
    ThrowError(env, "Windows file path does not have a parent directory.");
    return false;
  }

  size_t separator = path_end;
  while (separator > 0 && !IsPathSeparator(path[separator - 1])) {
    --separator;
  }
  if (separator == 0) {
    ThrowError(env, "Windows file path does not have a parent directory.");
    return false;
  }

  const bool is_drive_root = separator == 3 && path[1] == u':';
  const bool is_extended_drive_root = separator == 7 && path[0] == u'\\' &&
      path[1] == u'\\' && path[2] == u'?' && path[3] == u'\\' &&
      IsAsciiLetter(path[4]) && path[5] == u':';
  const size_t parent_length = is_drive_root || is_extended_drive_root
      ? separator
      : separator - 1;
  parent->assign(path.data(), parent_length);
  if (!IsAbsoluteWindowsPath(*parent)) {
    ThrowError(env, "Windows file parent directory must be absolute.");
    return false;
  }
  return true;
}

bool GetUtf16String(napi_env env, napi_value value, std::u16string* output) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowError(env, "Windows file path must be a string.");
    return false;
  }

  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) {
    ThrowError(env, "Unable to read Windows file path.");
    return false;
  }

  std::vector<char16_t> buffer(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf16(
          env, value, buffer.data(), buffer.size(), &copied) != napi_ok) {
    ThrowError(env, "Unable to read Windows file path.");
    return false;
  }

  output->assign(buffer.data(), copied);
  if (output->find(u'\0') != std::u16string::npos ||
      !IsAbsoluteWindowsPath(*output)) {
    ThrowError(env, "Windows file path must be absolute and NUL-free.");
    return false;
  }
  return true;
}

bool GetAsciiHexString(
    napi_env env,
    napi_value value,
    size_t expected_length,
    std::string* output) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    ThrowError(env, "Windows file identity contains an invalid hexadecimal value.");
    return false;
  }

  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok ||
      length != expected_length) {
    ThrowError(env, "Windows file identity contains an invalid hexadecimal value.");
    return false;
  }

  std::vector<char> buffer(length + 1);
  size_t copied = 0;
  if (napi_get_value_string_utf8(
          env, value, buffer.data(), buffer.size(), &copied) != napi_ok ||
      copied != expected_length) {
    ThrowError(env, "Windows file identity contains an invalid hexadecimal value.");
    return false;
  }

  for (const char character : std::string(buffer.data(), copied)) {
    const bool is_digit = character >= '0' && character <= '9';
    const bool is_lower_hex = character >= 'a' && character <= 'f';
    if (!is_digit && !is_lower_hex) {
      ThrowError(env, "Windows file identity contains an invalid hexadecimal value.");
      return false;
    }
  }
  output->assign(buffer.data(), copied);
  return true;
}

bool GetNamedProperty(
    napi_env env,
    napi_value object,
    const char* name,
    napi_value* output) {
  if (napi_get_named_property(env, object, name, output) != napi_ok) {
    ThrowError(env, "Windows file identity is missing a required property.");
    return false;
  }
  return true;
}

bool GetExpectedIdentity(
    napi_env env,
    napi_value value,
    CapturedIdentity* output) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object) {
    ThrowError(env, "Windows file identity must be an object.");
    return false;
  }

  napi_value volume_serial;
  napi_value file_id;
  napi_value link_count;
  if (!GetNamedProperty(env, value, "volumeSerial", &volume_serial) ||
      !GetNamedProperty(env, value, "fileId", &file_id) ||
      !GetNamedProperty(env, value, "linkCount", &link_count) ||
      !GetAsciiHexString(env, volume_serial, 16, &output->volume_serial) ||
      !GetAsciiHexString(env, file_id, 32, &output->file_id)) {
    return false;
  }

  napi_valuetype link_count_type = napi_undefined;
  bool lossless = false;
  uint64_t parsed_link_count = 0;
  if (napi_typeof(env, link_count, &link_count_type) != napi_ok ||
      link_count_type != napi_bigint ||
      napi_get_value_bigint_uint64(
          env, link_count, &parsed_link_count, &lossless) != napi_ok ||
      !lossless || parsed_link_count != 1) {
    ThrowError(env, "Windows file identity link count must be 1n.");
    return false;
  }
  return true;
}

std::string FormatVolumeSerial(uint64_t serial) {
  std::string result(16, '0');
  uint64_t value = serial;
  for (size_t index = result.size(); index > 0; --index) {
    result[index - 1] = kLowerHex[value & 0x0fU];
    value >>= 4U;
  }
  return result;
}

std::string FormatFileId(const FILE_ID_128& file_id) {
  std::string result(32, '0');
  for (size_t index = 0; index < 16; ++index) {
    const BYTE value = file_id.Identifier[index];
    result[index * 2] = kLowerHex[(value >> 4U) & 0x0fU];
    result[index * 2 + 1] = kLowerHex[value & 0x0fU];
  }
  return result;
}

bool OpenAndCapture(
    napi_env env,
    const std::u16string& path,
    DWORD desired_access,
    ScopedHandle* handle,
    CapturedIdentity* identity) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  const HANDLE file = CreateFileW(
      reinterpret_cast<LPCWSTR>(path.c_str()),
      desired_access,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (file == INVALID_HANDLE_VALUE) {
    ThrowWin32Error(env, "CreateFileW");
    return false;
  }
  handle->reset(file);

  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(
          handle->get(), FileAttributeTagInfo, &attributes, sizeof(attributes))) {
    ThrowWin32Error(env, "GetFileInformationByHandleEx(FileAttributeTagInfo)");
    return false;
  }
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    ThrowError(env, "Windows file path resolves to a reparse point.");
    return false;
  }

  FILE_ID_INFO file_id{};
  if (!GetFileInformationByHandleEx(
          handle->get(), FileIdInfo, &file_id, sizeof(file_id))) {
    ThrowWin32Error(env, "GetFileInformationByHandleEx(FileIdInfo)");
    return false;
  }

  FILE_STANDARD_INFO standard_info{};
  if (!GetFileInformationByHandleEx(
          handle->get(), FileStandardInfo, &standard_info, sizeof(standard_info))) {
    ThrowWin32Error(env, "GetFileInformationByHandleEx(FileStandardInfo)");
    return false;
  }
  if (standard_info.NumberOfLinks != 1) {
    ThrowError(env, "Windows file must have exactly one hard link.");
    return false;
  }

  identity->volume_serial = FormatVolumeSerial(file_id.VolumeSerialNumber);
  identity->file_id = FormatFileId(file_id.FileId);
  return true;
}

bool OpenParentDirectory(
    napi_env env,
    const std::u16string& path,
    ScopedHandle* handle) {
  static_assert(sizeof(wchar_t) == sizeof(char16_t));
  const HANDLE directory = CreateFileW(
      reinterpret_cast<LPCWSTR>(path.c_str()),
      FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ,
      nullptr,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      nullptr);
  if (directory == INVALID_HANDLE_VALUE) {
    ThrowWin32Error(env, "CreateFileW(parent directory)");
    return false;
  }
  handle->reset(directory);

  FILE_ATTRIBUTE_TAG_INFO attributes{};
  if (!GetFileInformationByHandleEx(
          handle->get(), FileAttributeTagInfo, &attributes, sizeof(attributes))) {
    ThrowWin32Error(env, "GetFileInformationByHandleEx(parent FileAttributeTagInfo)");
    return false;
  }
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    ThrowError(env, "Windows file parent directory is a reparse point.");
    return false;
  }
  if ((attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
    ThrowError(env, "Windows file parent path is not a directory.");
    return false;
  }
  return true;
}

bool SameIdentity(const CapturedIdentity& left, const CapturedIdentity& right) {
  return left.volume_serial == right.volume_serial && left.file_id == right.file_id;
}

bool GetArguments(
    napi_env env,
    napi_callback_info info,
    size_t expected_count,
    napi_value* arguments) {
  size_t actual_count = 0;
  if (napi_get_cb_info(env, info, &actual_count, nullptr, nullptr, nullptr) != napi_ok ||
      actual_count != expected_count) {
    ThrowError(env, "Windows file operation received an invalid argument count.");
    return false;
  }
  size_t copied_count = expected_count;
  if (napi_get_cb_info(
          env, info, &copied_count, arguments, nullptr, nullptr) != napi_ok ||
      copied_count != expected_count) {
    ThrowError(env, "Windows file operation could not read its arguments.");
    return false;
  }
  return true;
}

napi_value CreateIdentityValue(napi_env env, const CapturedIdentity& identity) {
  napi_value result;
  napi_value volume_serial;
  napi_value file_id;
  napi_value link_count;
  if (napi_create_object(env, &result) != napi_ok ||
      napi_create_string_utf8(
          env, identity.volume_serial.c_str(), identity.volume_serial.size(),
          &volume_serial) != napi_ok ||
      napi_create_string_utf8(env, identity.file_id.c_str(), identity.file_id.size(),
                              &file_id) != napi_ok ||
      napi_create_bigint_uint64(env, 1, &link_count) != napi_ok ||
      napi_set_named_property(env, result, "volumeSerial", volume_serial) != napi_ok ||
      napi_set_named_property(env, result, "fileId", file_id) != napi_ok ||
      napi_set_named_property(env, result, "linkCount", link_count) != napi_ok) {
    ThrowError(env, "Unable to return Windows file identity.");
    return nullptr;
  }
  return result;
}

napi_value CreateResultString(napi_env env, const char* value) {
  napi_value result;
  if (napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result) != napi_ok) {
    ThrowError(env, "Unable to return Windows file operation result.");
    return nullptr;
  }
  return result;
}

napi_value CaptureFileIdentity(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  if (!GetArguments(env, info, 1, arguments)) {
    return nullptr;
  }

  std::u16string path;
  if (!GetUtf16String(env, arguments[0], &path)) {
    return nullptr;
  }

  ScopedHandle handle;
  CapturedIdentity identity;
  if (!OpenAndCapture(env, path, FILE_READ_ATTRIBUTES, &handle, &identity)) {
    return nullptr;
  }
  return CreateIdentityValue(env, identity);
}

napi_value DeleteFileIfMatches(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!GetArguments(env, info, 2, arguments)) {
    return nullptr;
  }

  std::u16string path;
  CapturedIdentity expected;
  if (!GetUtf16String(env, arguments[0], &path) ||
      !GetExpectedIdentity(env, arguments[1], &expected)) {
    return nullptr;
  }

  ScopedHandle handle;
  CapturedIdentity actual;
  if (!OpenAndCapture(
          env, path, DELETE | FILE_READ_ATTRIBUTES, &handle, &actual)) {
    return nullptr;
  }
  if (!SameIdentity(actual, expected)) {
    return CreateResultString(env, "identity-mismatch");
  }

  FILE_DISPOSITION_INFO disposition{};
  disposition.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(
          handle.get(), FileDispositionInfo, &disposition, sizeof(disposition))) {
    ThrowWin32Error(env, "SetFileInformationByHandle(FileDispositionInfo)");
    return nullptr;
  }
  return CreateResultString(env, "deleted");
}

bool CloseHeldHandles(HeldHandle* hold) {
  bool all_closed = true;
  if (hold->directory_handle != INVALID_HANDLE_VALUE) {
    if (CloseHandle(hold->directory_handle)) {
      hold->directory_handle = INVALID_HANDLE_VALUE;
    } else {
      all_closed = false;
    }
  }
  if (hold->file_handle != INVALID_HANDLE_VALUE) {
    if (CloseHandle(hold->file_handle)) {
      hold->file_handle = INVALID_HANDLE_VALUE;
    } else {
      all_closed = false;
    }
  }
  return all_closed;
}

void FinalizeHeldHandle(napi_env /*env*/, void* data, void* /*hint*/) {
  auto* hold = static_cast<HeldHandle*>(data);
  if (hold != nullptr) {
    CloseHeldHandles(hold);
    delete hold;
  }
}

napi_value HoldFileIfMatches(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  if (!GetArguments(env, info, 2, arguments)) {
    return nullptr;
  }

  std::u16string path;
  CapturedIdentity expected;
  if (!GetUtf16String(env, arguments[0], &path) ||
      !GetExpectedIdentity(env, arguments[1], &expected)) {
    return nullptr;
  }

  ScopedHandle initial_file_handle;
  CapturedIdentity actual;
  if (!OpenAndCapture(
          env, path, FILE_READ_ATTRIBUTES, &initial_file_handle, &actual)) {
    return nullptr;
  }
  if (!SameIdentity(actual, expected)) {
    ThrowError(env, "Windows file identity did not match the expected file.");
    return nullptr;
  }

  std::u16string parent_path;
  if (!GetImmediateParentDirectory(env, path, &parent_path)) {
    return nullptr;
  }

  ScopedHandle parent_directory_handle;
  if (!OpenParentDirectory(env, parent_path, &parent_directory_handle)) {
    return nullptr;
  }

  ScopedHandle verified_file_handle;
  CapturedIdentity verified_identity;
  if (!OpenAndCapture(
          env, path, FILE_READ_ATTRIBUTES, &verified_file_handle,
          &verified_identity)) {
    return nullptr;
  }
  if (!SameIdentity(verified_identity, expected)) {
    ThrowError(env, "Windows file identity changed while acquiring its hold.");
    return nullptr;
  }

  auto* hold = new (std::nothrow) HeldHandle(
      INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE);
  if (hold == nullptr) {
    ThrowError(env, "Unable to allocate Windows file hold.");
    return nullptr;
  }
  hold->file_handle = verified_file_handle.release();
  hold->directory_handle = parent_directory_handle.release();

  napi_value external;
  if (napi_create_external(env, hold, FinalizeHeldHandle, nullptr, &external) != napi_ok) {
    FinalizeHeldHandle(env, hold, nullptr);
    ThrowError(env, "Unable to create Windows file hold.");
    return nullptr;
  }
  if (napi_type_tag_object(env, external, &kHoldTypeTag) != napi_ok) {
    CloseHeldHandles(hold);
    ThrowError(env, "Unable to tag Windows file hold.");
    return nullptr;
  }
  return external;
}

napi_value ReleaseFileHold(napi_env env, napi_callback_info info) {
  napi_value arguments[1];
  if (!GetArguments(env, info, 1, arguments)) {
    return nullptr;
  }

  bool is_our_hold = false;
  if (napi_check_object_type_tag(env, arguments[0], &kHoldTypeTag, &is_our_hold) !=
          napi_ok ||
      !is_our_hold) {
    ThrowError(env, "Windows file hold is invalid.");
    return nullptr;
  }

  void* data = nullptr;
  if (napi_get_value_external(env, arguments[0], &data) != napi_ok || data == nullptr) {
    ThrowError(env, "Windows file hold is invalid.");
    return nullptr;
  }
  auto* hold = static_cast<HeldHandle*>(data);
  if (!CloseHeldHandles(hold)) {
    ThrowWin32Error(env, "CloseHandle");
    return nullptr;
  }

  napi_value undefined;
  if (napi_get_undefined(env, &undefined) != napi_ok) {
    ThrowError(env, "Unable to return Windows file hold release result.");
    return nullptr;
  }
  return undefined;
}

napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
      {"captureFileIdentity", nullptr, CaptureFileIdentity, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"deleteFileIfMatches", nullptr, DeleteFileIfMatches, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"holdFileIfMatches", nullptr, HoldFileIfMatches, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"releaseFileHold", nullptr, ReleaseFileHold, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  if (napi_define_properties(
          env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) {
    ThrowError(env, "Unable to initialize Windows file operations.");
    return nullptr;
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
