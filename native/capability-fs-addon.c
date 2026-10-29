#define _DARWIN_C_SOURCE

#include <node_api.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef enum {
    UA_REMOVE_OK = 0,
    UA_REMOVE_OPERATION_FAILED,
    UA_REMOVE_IDENTITY_MISMATCH,
    UA_REMOVE_SYNC_FAILED
} ua_remove_result;

typedef enum {
    UA_ENTRY_FILE = 0,
    UA_ENTRY_DIRECTORY,
    UA_ENTRY_SYMLINK
} ua_entry_type;

typedef enum {
    UA_RENAME_SOURCE_TO_ANCHOR = 0,
    UA_RENAME_VERIFY_ANCHOR,
    UA_RENAME_ANCHOR_TO_TARGET,
    UA_RENAME_VERIFY_TARGET,
    UA_RENAME_SYNC
} ua_rename_phase;

typedef enum {
    UA_RENAME_SOURCE_UNCHANGED = 0,
    UA_RENAME_RESTORED,
    UA_RENAME_ANCHOR_RETAINED,
    UA_RENAME_PUBLISHED,
    UA_RENAME_UNKNOWN
} ua_rename_disposition;

typedef struct {
    char bytes[NAME_MAX + 1];
    size_t length;
} ua_basename;

typedef struct ua_entry_snapshot ua_entry_snapshot;

typedef struct {
    struct stat identity;
    ua_entry_snapshot *items;
    size_t length;
    size_t capacity;
} ua_directory_snapshot;

struct ua_entry_snapshot {
    char *name;
    struct stat identity;
    ua_directory_snapshot children;
};

#ifdef UA_ATOMIC_FS_TESTING
static int ua_test_fsync_errno = 0;
static unsigned int ua_test_fsync_failures = 0U;
static unsigned int ua_test_fsync_successes_before_failure = 0U;
static napi_ref ua_test_before_remove_hook = NULL;
static napi_ref ua_test_before_first_rename_hook = NULL;
static napi_ref ua_test_before_second_rename_hook = NULL;
#endif

static napi_value throw_code(napi_env env, const char *code) {
    (void)napi_throw_error(env, code, code);
    return NULL;
}

static const char *rename_phase_name(ua_rename_phase phase) {
    switch (phase) {
        case UA_RENAME_SOURCE_TO_ANCHOR: return "source_to_anchor";
        case UA_RENAME_VERIFY_ANCHOR: return "verify_anchor";
        case UA_RENAME_ANCHOR_TO_TARGET: return "anchor_to_target";
        case UA_RENAME_VERIFY_TARGET: return "verify_target";
        case UA_RENAME_SYNC: return "sync";
    }
    return "verify_target";
}

static const char *rename_disposition_name(ua_rename_disposition disposition) {
    switch (disposition) {
        case UA_RENAME_SOURCE_UNCHANGED: return "source_unchanged";
        case UA_RENAME_RESTORED: return "restored";
        case UA_RENAME_ANCHOR_RETAINED: return "anchor_retained";
        case UA_RENAME_PUBLISHED: return "published";
        case UA_RENAME_UNKNOWN: return "unknown";
    }
    return "unknown";
}

static bool set_named_string(napi_env env, napi_value object, const char *name, const char *value) {
    napi_value property = NULL;
    return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &property) == napi_ok &&
           napi_set_named_property(env, object, name, property) == napi_ok;
}

static bool set_named_boolean(napi_env env, napi_value object, const char *name, bool value) {
    napi_value property = NULL;
    return napi_get_boolean(env, value, &property) == napi_ok &&
           napi_set_named_property(env, object, name, property) == napi_ok;
}

static napi_value create_rename_outcome(napi_env env, ua_rename_phase phase,
                                        ua_rename_disposition disposition, bool applied) {
    napi_value outcome = NULL;
    if (napi_create_object(env, &outcome) != napi_ok ||
        !set_named_string(env, outcome, "phase", rename_phase_name(phase)) ||
        !set_named_string(env, outcome, "disposition", rename_disposition_name(disposition)) ||
        !set_named_boolean(env, outcome, "applied", applied)) return NULL;
    return outcome;
}

static napi_value throw_rename_code(napi_env env, const char *code, ua_rename_phase phase,
                                    ua_rename_disposition disposition, bool applied) {
    napi_value code_value = NULL;
    napi_value message = NULL;
    napi_value error = NULL;
    if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
        napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &message) != napi_ok ||
        napi_create_error(env, code_value, message, &error) != napi_ok ||
        !set_named_string(env, error, "phase", rename_phase_name(phase)) ||
        !set_named_string(env, error, "disposition", rename_disposition_name(disposition)) ||
        !set_named_boolean(env, error, "applied", applied)) return NULL;
    (void)napi_throw(env, error);
    return NULL;
}

static bool get_arguments(napi_env env, napi_callback_info info, size_t expected, napi_value *values) {
    size_t count = expected + 1U;
    if (napi_get_cb_info(env, info, &count, values, NULL, NULL) != napi_ok || count != expected) {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    return true;
}

static bool get_strict_int32(napi_env env, napi_value value, int32_t minimum, int32_t *result) {
    napi_valuetype type = napi_undefined;
    double number = 0.0;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
        napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) ||
        number < (double)minimum || number > (double)INT32_MAX || floor(number) != number) {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    *result = (int32_t)number;
    return true;
}

static bool get_basename(napi_env env, napi_value value, ua_basename *result) {
    napi_valuetype type = napi_undefined;
    size_t length = 0U;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, value, NULL, 0U, &length) != napi_ok ||
        length == 0U || length > (size_t)NAME_MAX ||
        napi_get_value_string_utf8(env, value, result->bytes, sizeof(result->bytes), &result->length) != napi_ok ||
        result->length != length) {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    if ((length == 1U && result->bytes[0] == '.') ||
        (length == 2U && result->bytes[0] == '.' && result->bytes[1] == '.')) {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    for (size_t index = 0U; index < length; index++) {
        const unsigned char byte = (unsigned char)result->bytes[index];
        if (byte == '/' || byte < 0x20U || byte == 0x7fU) {
            (void)throw_code(env, "invalid_argument");
            return false;
        }
    }
    return true;
}

static bool get_u64_string(napi_env env, napi_value value, uint64_t *result) {
    napi_valuetype type = napi_undefined;
    char text[32];
    size_t length = 0U;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, value, NULL, 0U, &length) != napi_ok ||
        length == 0U || length >= sizeof(text) ||
        napi_get_value_string_utf8(env, value, text, sizeof(text), &length) != napi_ok) {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    for (size_t index = 0U; index < length; index++) {
        if (text[index] < '0' || text[index] > '9') {
            (void)throw_code(env, "invalid_argument");
            return false;
        }
    }
    errno = 0;
    char *end = NULL;
    const unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0') {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    *result = (uint64_t)parsed;
    return true;
}

static bool get_entry_type(napi_env env, napi_value value, ua_entry_type *result) {
    napi_valuetype type = napi_undefined;
    char text[16];
    size_t length = 0U;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
        napi_get_value_string_utf8(env, value, text, sizeof(text), &length) != napi_ok) {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    if (strcmp(text, "file") == 0) *result = UA_ENTRY_FILE;
    else if (strcmp(text, "directory") == 0) *result = UA_ENTRY_DIRECTORY;
    else if (strcmp(text, "symlink") == 0) *result = UA_ENTRY_SYMLINK;
    else {
        (void)throw_code(env, "invalid_argument");
        return false;
    }
    return true;
}

static bool valid_directory_fd(int fd) {
    struct stat info;
    return fstat(fd, &info) == 0 && S_ISDIR(info.st_mode);
}

static bool same_identity(const struct stat *info, uint64_t device, uint64_t inode) {
    return (uint64_t)info->st_dev == device && (uint64_t)info->st_ino == inode;
}

static bool same_entry_type(const struct stat *info, ua_entry_type expected) {
    if (expected == UA_ENTRY_FILE) return S_ISREG(info->st_mode);
    if (expected == UA_ENTRY_DIRECTORY) return S_ISDIR(info->st_mode);
    return S_ISLNK(info->st_mode);
}

static bool same_stat_identity(const struct stat *left, const struct stat *right) {
    return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static bool same_directory_version(const struct stat *left, const struct stat *right) {
    return same_stat_identity(left, right) && S_ISDIR(left->st_mode) && S_ISDIR(right->st_mode) &&
           left->st_mode == right->st_mode &&
           left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
           left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
           left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
           left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static bool sync_fd(int fd) {
    for (;;) {
        int result;
#ifdef UA_ATOMIC_FS_TESTING
        if (ua_test_fsync_failures > 0U) {
            if (ua_test_fsync_successes_before_failure > 0U) {
                ua_test_fsync_successes_before_failure--;
                result = fsync(fd);
            } else {
                ua_test_fsync_failures--;
                errno = ua_test_fsync_errno;
                result = -1;
            }
        } else {
            result = fsync(fd);
        }
#else
        result = fsync(fd);
#endif
        if (result == 0) return true;
        if (errno != EINTR) return false;
    }
}

#ifdef UA_ATOMIC_FS_TESTING
static bool run_test_hook(napi_env env, napi_ref *hook_slot) {
    if (*hook_slot == NULL) return true;
    napi_ref hook_reference = *hook_slot;
    *hook_slot = NULL;
    napi_value hook = NULL;
    napi_value receiver = NULL;
    napi_value ignored = NULL;
    const bool ready = napi_get_reference_value(env, hook_reference, &hook) == napi_ok &&
                       napi_get_global(env, &receiver) == napi_ok;
    (void)napi_delete_reference(env, hook_reference);
    return ready && napi_call_function(env, receiver, hook, 0U, NULL, &ignored) == napi_ok;
}

static napi_value set_test_hook(napi_env env, napi_callback_info info, napi_ref *hook_slot) {
    napi_value arguments[2];
    napi_valuetype type = napi_undefined;
    if (!get_arguments(env, info, 1U, arguments) ||
        napi_typeof(env, arguments[0], &type) != napi_ok || type != napi_function)
        return throw_code(env, "invalid_argument");
    if (*hook_slot != NULL) {
        (void)napi_delete_reference(env, *hook_slot);
        *hook_slot = NULL;
    }
    if (napi_create_reference(env, arguments[0], 1U, hook_slot) != napi_ok)
        return throw_code(env, "operation_failed");
    napi_value undefined_value = NULL;
    if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
    return undefined_value;
}

static napi_value test_set_before_remove_hook(napi_env env, napi_callback_info info) {
    return set_test_hook(env, info, &ua_test_before_remove_hook);
}

static napi_value test_set_before_first_rename_hook(napi_env env, napi_callback_info info) {
    return set_test_hook(env, info, &ua_test_before_first_rename_hook);
}

static napi_value test_set_before_second_rename_hook(napi_env env, napi_callback_info info) {
    return set_test_hook(env, info, &ua_test_before_second_rename_hook);
}

static napi_value test_fail_next_fsync(napi_env env, napi_callback_info info) {
    napi_value arguments[3];
    int32_t error_number = 0;
    int32_t failures = 0;
    if (!get_arguments(env, info, 2U, arguments) ||
        !get_strict_int32(env, arguments[0], 1, &error_number) ||
        !get_strict_int32(env, arguments[1], 1, &failures)) return NULL;
    ua_test_fsync_errno = error_number;
    ua_test_fsync_failures = (unsigned int)failures;
    ua_test_fsync_successes_before_failure = 0U;
    napi_value undefined_value = NULL;
    if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
    return undefined_value;
}

static napi_value test_fail_fsync_after(napi_env env, napi_callback_info info) {
    napi_value arguments[3];
    int32_t error_number = 0;
    int32_t successful_calls = 0;
    if (!get_arguments(env, info, 2U, arguments) ||
        !get_strict_int32(env, arguments[0], 1, &error_number) ||
        !get_strict_int32(env, arguments[1], 0, &successful_calls)) return NULL;
    ua_test_fsync_errno = error_number;
    ua_test_fsync_failures = 1U;
    ua_test_fsync_successes_before_failure = (unsigned int)successful_calls;
    napi_value undefined_value = NULL;
    if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
    return undefined_value;
}
#endif

static napi_value rename_exclusive(napi_env env, napi_callback_info info) {
    napi_value arguments[7];
    int32_t parent_fd = -1;
    ua_basename from;
    ua_basename to;
    uint64_t expected_device = 0U;
    uint64_t expected_inode = 0U;
    ua_entry_type expected_type = UA_ENTRY_FILE;
    if (!get_arguments(env, info, 6U, arguments) ||
        !get_strict_int32(env, arguments[0], 0, &parent_fd) ||
        !get_basename(env, arguments[1], &from) ||
        !get_basename(env, arguments[2], &to) ||
        !get_u64_string(env, arguments[3], &expected_device) ||
        !get_u64_string(env, arguments[4], &expected_inode) ||
        !get_entry_type(env, arguments[5], &expected_type)) return NULL;
    if (from.length == to.length && memcmp(from.bytes, to.bytes, from.length) == 0)
        return throw_code(env, "invalid_argument");
    if (!valid_directory_fd(parent_fd)) return throw_code(env, "operation_failed");

    /*
     * Legacy two-name API: this native preflight pins the parent and avoids a
     * JavaScript round trip, but Darwin still cannot atomically bind this stat
     * to the following pathname rename. New security-sensitive callers use
     * rename_anchored's capture -> verify -> publish boundary instead.
     */
    struct stat source;
    if (fstatat(parent_fd, from.bytes, &source, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT) return throw_code(env, "source_not_found");
        return throw_code(env, "operation_failed");
    }
    if (!same_identity(&source, expected_device, expected_inode) || !same_entry_type(&source, expected_type))
        return throw_code(env, "identity_mismatch");

    if (renameatx_np(parent_fd, from.bytes, parent_fd, to.bytes, RENAME_EXCL) != 0) {
        const int operation_errno = errno;
        if (operation_errno == EEXIST) return throw_code(env, "destination_exists");
        if (operation_errno == ENOENT) return throw_code(env, "source_not_found");
        return throw_code(env, "operation_failed");
    }
    if (!sync_fd(parent_fd)) return throw_code(env, "sync_failed");

    napi_value undefined_value = NULL;
    if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
    return undefined_value;
}

/*
 * Capture a source name into a caller-recorded, high-entropy anchor before
 * trusting its identity.  Darwin has no rename-by-fd primitive, so this is a
 * capture -> verify -> publish boundary rather than an inode-CAS.  In
 * particular, a failed verification is never undone by another pathname
 * rename: the captured entry stays recoverable under the anchor.
 */
static napi_value rename_anchored(napi_env env, napi_callback_info info) {
    napi_value arguments[8];
    int32_t parent_fd = -1;
    ua_basename source_name;
    ua_basename anchor_name;
    ua_basename target_name;
    uint64_t expected_device = 0U;
    uint64_t expected_inode = 0U;
    ua_entry_type expected_type = UA_ENTRY_FILE;
    if (!get_arguments(env, info, 7U, arguments) ||
        !get_strict_int32(env, arguments[0], 0, &parent_fd) ||
        !get_basename(env, arguments[1], &source_name) ||
        !get_basename(env, arguments[2], &anchor_name) ||
        !get_basename(env, arguments[3], &target_name) ||
        !get_u64_string(env, arguments[4], &expected_device) ||
        !get_u64_string(env, arguments[5], &expected_inode) ||
        !get_entry_type(env, arguments[6], &expected_type)) return NULL;
    if ((source_name.length == anchor_name.length &&
         memcmp(source_name.bytes, anchor_name.bytes, source_name.length) == 0) ||
        (source_name.length == target_name.length &&
         memcmp(source_name.bytes, target_name.bytes, source_name.length) == 0) ||
        (anchor_name.length == target_name.length &&
         memcmp(anchor_name.bytes, target_name.bytes, anchor_name.length) == 0))
        return throw_code(env, "invalid_argument");
    if (!valid_directory_fd(parent_fd)) return throw_code(env, "operation_failed");

    /* This preflight avoids capturing a source already known to be wrong. */
    struct stat source;
    if (fstatat(parent_fd, source_name.bytes, &source, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT)
            return throw_rename_code(env, "source_not_found", UA_RENAME_SOURCE_TO_ANCHOR,
                                     UA_RENAME_SOURCE_UNCHANGED, false);
        return throw_rename_code(env, "operation_failed", UA_RENAME_SOURCE_TO_ANCHOR,
                                 UA_RENAME_SOURCE_UNCHANGED, false);
    }
    if (!same_identity(&source, expected_device, expected_inode) ||
        !same_entry_type(&source, expected_type))
        return throw_rename_code(env, "identity_mismatch", UA_RENAME_SOURCE_TO_ANCHOR,
                                 UA_RENAME_SOURCE_UNCHANGED, false);

#ifdef UA_ATOMIC_FS_TESTING
    if (!run_test_hook(env, &ua_test_before_first_rename_hook)) return NULL;
#endif

    if (renameatx_np(parent_fd, source_name.bytes, parent_fd, anchor_name.bytes, RENAME_EXCL) != 0) {
        const int operation_errno = errno;
        if (operation_errno == EEXIST)
            return throw_rename_code(env, "anchor_exists", UA_RENAME_SOURCE_TO_ANCHOR,
                                     UA_RENAME_SOURCE_UNCHANGED, false);
        if (operation_errno == ENOENT)
            return throw_rename_code(env, "source_not_found", UA_RENAME_SOURCE_TO_ANCHOR,
                                     UA_RENAME_SOURCE_UNCHANGED, false);
        return throw_rename_code(env, "operation_failed", UA_RENAME_SOURCE_TO_ANCHOR,
                                 UA_RENAME_SOURCE_UNCHANGED, false);
    }

    struct stat anchored;
    const int anchor_stat_result = fstatat(parent_fd, anchor_name.bytes, &anchored, AT_SYMLINK_NOFOLLOW);
    const int anchor_stat_errno = errno;
    const bool anchor_present = anchor_stat_result == 0;
    const bool anchor_matches = anchor_present &&
        same_identity(&anchored, expected_device, expected_inode) && same_entry_type(&anchored, expected_type);

    if (!anchor_matches) {
        /* Persist the retained evidence before reporting a detected race. */
        if (!sync_fd(parent_fd))
            return throw_rename_code(env, "sync_failed", UA_RENAME_SYNC,
                                     anchor_present ? UA_RENAME_ANCHOR_RETAINED : UA_RENAME_UNKNOWN, false);
        const char *code = anchor_present || anchor_stat_errno == ENOENT
            ? "identity_mismatch" : "operation_failed";
        return throw_rename_code(env, code, UA_RENAME_VERIFY_ANCHOR,
                                 anchor_present ? UA_RENAME_ANCHOR_RETAINED : UA_RENAME_UNKNOWN, false);
    }
    /* The verified anchor is the first durable recovery boundary. */
    if (!sync_fd(parent_fd))
        return throw_rename_code(env, "sync_failed", UA_RENAME_SYNC, UA_RENAME_ANCHOR_RETAINED, false);

#ifdef UA_ATOMIC_FS_TESTING
    if (!run_test_hook(env, &ua_test_before_second_rename_hook)) return NULL;
#endif

    if (renameatx_np(parent_fd, anchor_name.bytes, parent_fd, target_name.bytes, RENAME_EXCL) != 0) {
        const int operation_errno = errno;
        struct stat retained;
        const bool expected_retained =
            fstatat(parent_fd, anchor_name.bytes, &retained, AT_SYMLINK_NOFOLLOW) == 0 &&
            same_identity(&retained, expected_device, expected_inode) &&
            same_entry_type(&retained, expected_type);
        const ua_rename_disposition disposition = expected_retained
            ? UA_RENAME_ANCHOR_RETAINED : UA_RENAME_UNKNOWN;
        if (operation_errno == EEXIST)
            return throw_rename_code(env, "destination_exists", UA_RENAME_ANCHOR_TO_TARGET,
                                     disposition, false);
        if (operation_errno == ENOENT)
            return throw_rename_code(env, "source_not_found", UA_RENAME_ANCHOR_TO_TARGET,
                                     disposition, false);
        return throw_rename_code(env, "operation_failed", UA_RENAME_ANCHOR_TO_TARGET,
                                 disposition, false);
    }

    struct stat target;
    const int target_stat_result = fstatat(parent_fd, target_name.bytes, &target, AT_SYMLINK_NOFOLLOW);
    const int target_stat_errno = errno;
    const bool target_present = target_stat_result == 0;
    const bool target_matches = target_present &&
        same_identity(&target, expected_device, expected_inode) && same_entry_type(&target, expected_type);

    if (!target_matches) {
        if (!sync_fd(parent_fd))
            return throw_rename_code(env, "sync_failed", UA_RENAME_SYNC, UA_RENAME_UNKNOWN, false);
        const char *code = target_present || target_stat_errno == ENOENT
            ? "identity_mismatch" : "operation_failed";
        return throw_rename_code(env, code, UA_RENAME_VERIFY_TARGET, UA_RENAME_UNKNOWN, false);
    }
    if (!sync_fd(parent_fd))
        return throw_rename_code(env, "sync_failed", UA_RENAME_SYNC, UA_RENAME_PUBLISHED, true);

    return create_rename_outcome(env, UA_RENAME_SYNC, UA_RENAME_PUBLISHED, true);
}

static bool valid_directory_entry_name(const char *name) {
    const size_t length = strnlen(name, (size_t)NAME_MAX + 1U);
    if (length == 0U || length > (size_t)NAME_MAX) return false;
    if ((length == 1U && name[0] == '.') ||
        (length == 2U && name[0] == '.' && name[1] == '.')) return false;
    for (size_t index = 0U; index < length; index++) {
        const unsigned char byte = (unsigned char)name[index];
        if (byte == '/' || byte < 0x20U || byte == 0x7fU) return false;
    }
    return true;
}

static void free_directory_snapshot(ua_directory_snapshot *snapshot) {
    for (size_t index = 0U; index < snapshot->length; index++) {
        free(snapshot->items[index].name);
        free_directory_snapshot(&snapshot->items[index].children);
    }
    free(snapshot->items);
    memset(snapshot, 0, sizeof(*snapshot));
}

static ua_entry_snapshot *append_snapshot_entry(ua_directory_snapshot *snapshot, const char *name,
                                                const struct stat *identity) {
    if (snapshot->length == snapshot->capacity) {
        const size_t capacity = snapshot->capacity == 0U ? 16U : snapshot->capacity * 2U;
        if (capacity < snapshot->capacity || capacity > SIZE_MAX / sizeof(*snapshot->items)) return NULL;
        ua_entry_snapshot *resized = realloc(snapshot->items, capacity * sizeof(*snapshot->items));
        if (resized == NULL) return NULL;
        snapshot->items = resized;
        snapshot->capacity = capacity;
    }
    const size_t length = strlen(name);
    char *copy = malloc(length + 1U);
    if (copy == NULL) return NULL;
    memcpy(copy, name, length + 1U);

    ua_entry_snapshot *entry = &snapshot->items[snapshot->length++];
    memset(entry, 0, sizeof(*entry));
    entry->name = copy;
    entry->identity = *identity;
    return entry;
}

static int compare_snapshot_entries(const void *left, const void *right) {
    const ua_entry_snapshot *left_entry = left;
    const ua_entry_snapshot *right_entry = right;
    return strcmp(left_entry->name, right_entry->name);
}

static const ua_entry_snapshot *find_snapshot_entry(const ua_directory_snapshot *snapshot, const char *name) {
    size_t lower = 0U;
    size_t upper = snapshot->length;
    while (lower < upper) {
        const size_t middle = lower + (upper - lower) / 2U;
        const int comparison = strcmp(name, snapshot->items[middle].name);
        if (comparison == 0) return &snapshot->items[middle];
        if (comparison < 0) upper = middle;
        else lower = middle + 1U;
    }
    return NULL;
}

static int open_directory_scan_fd(int directory_fd) {
    return openat(directory_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
}

static ua_remove_result snapshot_directory(int directory_fd, const struct stat *expected,
                                           ua_directory_snapshot *snapshot) {
    struct stat opened;
    if (fstat(directory_fd, &opened) != 0) return UA_REMOVE_OPERATION_FAILED;
    if (!S_ISDIR(opened.st_mode) || !same_stat_identity(&opened, expected))
        return UA_REMOVE_IDENTITY_MISMATCH;
    snapshot->identity = opened;

    const int scan_fd = open_directory_scan_fd(directory_fd);
    if (scan_fd < 0) return UA_REMOVE_OPERATION_FAILED;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        (void)close(scan_fd);
        return UA_REMOVE_OPERATION_FAILED;
    }

    ua_remove_result result = UA_REMOVE_OK;
    for (;;) {
        errno = 0;
        struct dirent *item = readdir(directory);
        if (item == NULL) {
            if (errno != 0) result = UA_REMOVE_OPERATION_FAILED;
            break;
        }
        const char *name = item->d_name;
        if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
        if (!valid_directory_entry_name(name)) {
            result = UA_REMOVE_OPERATION_FAILED;
            break;
        }

        struct stat identity;
        if (fstatat(directory_fd, name, &identity, AT_SYMLINK_NOFOLLOW) != 0) {
            result = errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
            break;
        }
        if ((uint64_t)item->d_ino != (uint64_t)identity.st_ino) {
            result = UA_REMOVE_IDENTITY_MISMATCH;
            break;
        }

        ua_entry_snapshot *entry = append_snapshot_entry(snapshot, name, &identity);
        if (entry == NULL) {
            result = UA_REMOVE_OPERATION_FAILED;
            break;
        }
        if (!S_ISDIR(identity.st_mode)) continue;

        const int child_fd = openat(directory_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (child_fd < 0) {
            result = (errno == ENOENT || errno == ELOOP || errno == ENOTDIR)
                ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
            break;
        }
        struct stat child_opened;
        if (fstat(child_fd, &child_opened) != 0) result = UA_REMOVE_OPERATION_FAILED;
        else if (!S_ISDIR(child_opened.st_mode) || !same_stat_identity(&child_opened, &identity))
            result = UA_REMOVE_IDENTITY_MISMATCH;
        else result = snapshot_directory(child_fd, &identity, &entry->children);
        if (close(child_fd) != 0 && result == UA_REMOVE_OK) result = UA_REMOVE_OPERATION_FAILED;
        if (result != UA_REMOVE_OK) break;

        struct stat after;
        if (fstatat(directory_fd, name, &after, AT_SYMLINK_NOFOLLOW) != 0) {
            result = errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
            break;
        }
        if (!same_stat_identity(&after, &identity)) {
            result = UA_REMOVE_IDENTITY_MISMATCH;
            break;
        }
    }
    if (closedir(directory) != 0 && result == UA_REMOVE_OK) result = UA_REMOVE_OPERATION_FAILED;

    struct stat finished;
    if (result == UA_REMOVE_OK && fstat(directory_fd, &finished) != 0) result = UA_REMOVE_OPERATION_FAILED;
    else if (result == UA_REMOVE_OK && !same_directory_version(&finished, &snapshot->identity))
        result = UA_REMOVE_IDENTITY_MISMATCH;
    if (result == UA_REMOVE_OK && snapshot->length > 1U)
        qsort(snapshot->items, snapshot->length, sizeof(*snapshot->items), compare_snapshot_entries);
    return result;
}

static ua_remove_result verify_directory_snapshot(int directory_fd, const ua_directory_snapshot *snapshot,
                                                  bool recurse, bool require_snapshot_version) {
    struct stat before_scan;
    if (fstat(directory_fd, &before_scan) != 0) return UA_REMOVE_OPERATION_FAILED;
    if (!S_ISDIR(before_scan.st_mode) || !same_stat_identity(&before_scan, &snapshot->identity))
        return UA_REMOVE_IDENTITY_MISMATCH;
    if (require_snapshot_version && !same_directory_version(&before_scan, &snapshot->identity))
        return UA_REMOVE_IDENTITY_MISMATCH;

    const int scan_fd = open_directory_scan_fd(directory_fd);
    if (scan_fd < 0) return UA_REMOVE_OPERATION_FAILED;
    DIR *directory = fdopendir(scan_fd);
    if (directory == NULL) {
        (void)close(scan_fd);
        return UA_REMOVE_OPERATION_FAILED;
    }

    size_t count = 0U;
    ua_remove_result result = UA_REMOVE_OK;
    for (;;) {
        errno = 0;
        struct dirent *item = readdir(directory);
        if (item == NULL) {
            if (errno != 0) result = UA_REMOVE_OPERATION_FAILED;
            break;
        }
        const char *name = item->d_name;
        if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) continue;
        if (!valid_directory_entry_name(name)) {
            result = UA_REMOVE_OPERATION_FAILED;
            break;
        }
        const ua_entry_snapshot *expected = find_snapshot_entry(snapshot, name);
        if (expected == NULL) {
            result = UA_REMOVE_IDENTITY_MISMATCH;
            break;
        }
        struct stat current;
        if (fstatat(directory_fd, name, &current, AT_SYMLINK_NOFOLLOW) != 0) {
            result = errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
            break;
        }
        if ((uint64_t)item->d_ino != (uint64_t)current.st_ino ||
            !same_stat_identity(&current, &expected->identity)) {
            result = UA_REMOVE_IDENTITY_MISMATCH;
            break;
        }
        count++;
    }
    if (closedir(directory) != 0 && result == UA_REMOVE_OK) result = UA_REMOVE_OPERATION_FAILED;
    if (result == UA_REMOVE_OK && count != snapshot->length) result = UA_REMOVE_IDENTITY_MISMATCH;

    struct stat after_scan;
    if (result == UA_REMOVE_OK && fstat(directory_fd, &after_scan) != 0) result = UA_REMOVE_OPERATION_FAILED;
    else if (result == UA_REMOVE_OK && !same_directory_version(&after_scan, &before_scan))
        result = UA_REMOVE_IDENTITY_MISMATCH;
    if (result != UA_REMOVE_OK || !recurse) return result;

    for (size_t index = 0U; index < snapshot->length; index++) {
        const ua_entry_snapshot *entry = &snapshot->items[index];
        if (!S_ISDIR(entry->identity.st_mode)) continue;
        const int child_fd = openat(directory_fd, entry->name,
                                    O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (child_fd < 0)
            return (errno == ENOENT || errno == ELOOP || errno == ENOTDIR)
                ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
        struct stat opened_child;
        if (fstat(child_fd, &opened_child) != 0) result = UA_REMOVE_OPERATION_FAILED;
        else if (!same_stat_identity(&opened_child, &entry->identity)) result = UA_REMOVE_IDENTITY_MISMATCH;
        else result = verify_directory_snapshot(child_fd, &entry->children, true, require_snapshot_version);
        if (close(child_fd) != 0 && result == UA_REMOVE_OK) result = UA_REMOVE_OPERATION_FAILED;
        if (result != UA_REMOVE_OK) return result;
    }
    return UA_REMOVE_OK;
}

static bool generate_quarantine_name(char output[NAME_MAX + 1]) {
    uint64_t random_words[2];
    arc4random_buf(random_words, sizeof(random_words));
    const int length = snprintf(output, NAME_MAX + 1U, ".ua-remove-%016" PRIx64 "%016" PRIx64,
                                random_words[0], random_words[1]);
    return length > 0 && length <= NAME_MAX;
}

static void restore_quarantine(int parent_fd, const char *quarantine, const char *original) {
    if (renameatx_np(parent_fd, quarantine, parent_fd, original, RENAME_EXCL) == 0) (void)sync_fd(parent_fd);
}

static ua_remove_result quarantine_entry(int parent_fd, const char *name, const struct stat *expected,
                                         char quarantine[NAME_MAX + 1]) {
    for (unsigned int attempt = 0U; attempt < 32U; attempt++) {
        if (!generate_quarantine_name(quarantine)) return UA_REMOVE_OPERATION_FAILED;
        if (renameatx_np(parent_fd, name, parent_fd, quarantine, RENAME_EXCL) != 0) {
            if (errno == EEXIST) continue;
            return errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
        }

        struct stat moved;
        if (fstatat(parent_fd, quarantine, &moved, AT_SYMLINK_NOFOLLOW) != 0) {
            const ua_remove_result result = errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
            restore_quarantine(parent_fd, quarantine, name);
            return result;
        }
        if (moved.st_dev != expected->st_dev || moved.st_ino != expected->st_ino) {
            restore_quarantine(parent_fd, quarantine, name);
            return UA_REMOVE_IDENTITY_MISMATCH;
        }
        return UA_REMOVE_OK;
    }
    return UA_REMOVE_OPERATION_FAILED;
}

static ua_remove_result verify_quarantine(int parent_fd, const char *quarantine, const struct stat *expected) {
    struct stat current;
    if (fstatat(parent_fd, quarantine, &current, AT_SYMLINK_NOFOLLOW) != 0)
        return errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
    return current.st_dev == expected->st_dev && current.st_ino == expected->st_ino
        ? UA_REMOVE_OK
        : UA_REMOVE_IDENTITY_MISMATCH;
}

static ua_remove_result remove_directory_contents(int directory_fd, const ua_directory_snapshot *snapshot);

static ua_remove_result remove_quarantined_entry(int parent_fd, const char *quarantine,
                                                 const struct stat *expected,
                                                 const ua_directory_snapshot *children) {
    ua_remove_result result = UA_REMOVE_OK;
    if (S_ISDIR(expected->st_mode)) {
        if (children == NULL) return UA_REMOVE_OPERATION_FAILED;
        const int child_fd = openat(parent_fd, quarantine, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (child_fd < 0)
            return (errno == ENOENT || errno == ELOOP || errno == ENOTDIR)
                ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
        struct stat opened;
        if (fstat(child_fd, &opened) != 0) result = UA_REMOVE_OPERATION_FAILED;
        else if (!same_stat_identity(&opened, expected))
            result = UA_REMOVE_IDENTITY_MISMATCH;
        else result = remove_directory_contents(child_fd, children);
        if (result == UA_REMOVE_OK && !sync_fd(child_fd)) result = UA_REMOVE_SYNC_FAILED;
        if (close(child_fd) != 0 && result == UA_REMOVE_OK) result = UA_REMOVE_OPERATION_FAILED;
        if (result != UA_REMOVE_OK) return result;
    }

    result = verify_quarantine(parent_fd, quarantine, expected);
    if (result != UA_REMOVE_OK) return result;
    if (unlinkat(parent_fd, quarantine, S_ISDIR(expected->st_mode) ? AT_REMOVEDIR : 0) != 0)
        return errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
    return sync_fd(parent_fd) ? UA_REMOVE_OK : UA_REMOVE_SYNC_FAILED;
}

static ua_remove_result remove_named_entry(int parent_fd, const char *name, const struct stat *expected,
                                           const ua_directory_snapshot *children) {
    char quarantine[NAME_MAX + 1];
    ua_remove_result result = quarantine_entry(parent_fd, name, expected, quarantine);
    if (result != UA_REMOVE_OK) return result;
    result = remove_quarantined_entry(parent_fd, quarantine, expected, children);
    if (result != UA_REMOVE_OK && result != UA_REMOVE_SYNC_FAILED)
        restore_quarantine(parent_fd, quarantine, name);
    return result;
}

static ua_remove_result remove_directory_contents(int directory_fd, const ua_directory_snapshot *snapshot) {
    ua_remove_result result = verify_directory_snapshot(directory_fd, snapshot, false, false);
    if (result != UA_REMOVE_OK) return result;

    for (size_t index = 0U; index < snapshot->length; index++) {
        const ua_entry_snapshot *entry = &snapshot->items[index];
        result = remove_named_entry(directory_fd, entry->name, &entry->identity,
                                    S_ISDIR(entry->identity.st_mode) ? &entry->children : NULL);
        if (result != UA_REMOVE_OK) return result;
    }
    return verify_directory_snapshot(directory_fd, &(ua_directory_snapshot){ .identity = snapshot->identity },
                                     false, false);
}

static napi_value remove_identity(napi_env env, napi_callback_info info) {
    napi_value arguments[5];
    int32_t parent_fd = -1;
    ua_basename name;
    uint64_t expected_device = 0U;
    uint64_t expected_inode = 0U;
    if (!get_arguments(env, info, 4U, arguments) ||
        !get_strict_int32(env, arguments[0], 0, &parent_fd) ||
        !get_basename(env, arguments[1], &name) ||
        !get_u64_string(env, arguments[2], &expected_device) ||
        !get_u64_string(env, arguments[3], &expected_inode)) return NULL;
    if (!valid_directory_fd(parent_fd)) return throw_code(env, "operation_failed");

    struct stat before;
    if (fstatat(parent_fd, name.bytes, &before, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT) return throw_code(env, "source_not_found");
        return throw_code(env, "operation_failed");
    }
    if (!same_identity(&before, expected_device, expected_inode))
        return throw_code(env, "identity_mismatch");

    ua_directory_snapshot snapshot = {0};
    ua_remove_result removed = UA_REMOVE_OK;
    int root_fd = -1;
    if (S_ISDIR(before.st_mode)) {
        root_fd = openat(parent_fd, name.bytes, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (root_fd < 0) {
            removed = (errno == ENOENT || errno == ELOOP || errno == ENOTDIR)
                ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
        } else {
            struct stat opened;
            if (fstat(root_fd, &opened) != 0) removed = UA_REMOVE_OPERATION_FAILED;
            else if (!same_stat_identity(&opened, &before)) removed = UA_REMOVE_IDENTITY_MISMATCH;
            else removed = snapshot_directory(root_fd, &before, &snapshot);
            if (removed == UA_REMOVE_OK)
                removed = verify_directory_snapshot(root_fd, &snapshot, true, true);
#ifdef UA_ATOMIC_FS_TESTING
            if (removed == UA_REMOVE_OK && !run_test_hook(env, &ua_test_before_remove_hook)) {
                (void)close(root_fd);
                free_directory_snapshot(&snapshot);
                return NULL;
            }
#endif
            if (close(root_fd) != 0 && removed == UA_REMOVE_OK) removed = UA_REMOVE_OPERATION_FAILED;
        }
    }
    if (removed == UA_REMOVE_OK) {
        struct stat current;
        if (fstatat(parent_fd, name.bytes, &current, AT_SYMLINK_NOFOLLOW) != 0)
            removed = errno == ENOENT ? UA_REMOVE_IDENTITY_MISMATCH : UA_REMOVE_OPERATION_FAILED;
        else if (!same_stat_identity(&current, &before)) removed = UA_REMOVE_IDENTITY_MISMATCH;
    }
    if (removed == UA_REMOVE_OK)
        removed = remove_named_entry(parent_fd, name.bytes, &before,
                                     S_ISDIR(before.st_mode) ? &snapshot : NULL);
    free_directory_snapshot(&snapshot);
    if (removed == UA_REMOVE_IDENTITY_MISMATCH) return throw_code(env, "identity_mismatch");
    if (removed == UA_REMOVE_SYNC_FAILED) return throw_code(env, "sync_failed");
    if (removed != UA_REMOVE_OK) return throw_code(env, "operation_failed");

    napi_value undefined_value = NULL;
    if (napi_get_undefined(env, &undefined_value) != napi_ok) return NULL;
    return undefined_value;
}

static napi_value process_start(napi_env env, napi_callback_info info) {
    napi_value arguments[2];
    int32_t pid = 0;
    if (!get_arguments(env, info, 1U, arguments) ||
        !get_strict_int32(env, arguments[0], 1, &pid)) return NULL;

    struct proc_bsdinfo process_info;
    memset(&process_info, 0, sizeof(process_info));
    errno = 0;
    const int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &process_info, (int)sizeof(process_info));
    if (bytes == 0 && errno == ESRCH) {
        napi_value null_value = NULL;
        if (napi_get_null(env, &null_value) != napi_ok) return NULL;
        return null_value;
    }
    if (bytes != (int)sizeof(process_info) || process_info.pbi_pid != (uint32_t)pid ||
        process_info.pbi_start_tvsec == 0U || process_info.pbi_start_tvusec >= 1000000U)
        return throw_code(env, "process_query_failed");

    char identity[64];
    const int length = snprintf(identity, sizeof(identity), "v1:%" PRIu64 ":%06" PRIu64,
                                process_info.pbi_start_tvsec, process_info.pbi_start_tvusec);
    if (length <= 0 || (size_t)length >= sizeof(identity)) return throw_code(env, "process_query_failed");
    napi_value result = NULL;
    if (napi_create_string_utf8(env, identity, (size_t)length, &result) != napi_ok) return NULL;
    return result;
}

static bool export_function(napi_env env, napi_value exports, const char *name, napi_callback callback) {
    napi_value function = NULL;
    return napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, NULL, &function) == napi_ok &&
           napi_set_named_property(env, exports, name, function) == napi_ok;
}

NAPI_MODULE_INIT() {
    if (!export_function(env, exports, "renameExclusive", rename_exclusive) ||
        !export_function(env, exports, "renameAnchored", rename_anchored) ||
        !export_function(env, exports, "removeIdentity", remove_identity) ||
        !export_function(env, exports, "processStart", process_start)
#ifdef UA_ATOMIC_FS_TESTING
        || !export_function(env, exports, "testSetBeforeRemoveHook", test_set_before_remove_hook)
        || !export_function(env, exports, "testSetBeforeFirstRenameHook", test_set_before_first_rename_hook)
        || !export_function(env, exports, "testSetBeforeSecondRenameHook", test_set_before_second_rename_hook)
        || !export_function(env, exports, "testFailNextFsync", test_fail_next_fsync)
        || !export_function(env, exports, "testFailFsyncAfter", test_fail_fsync_after)
#endif
    ) {
        (void)throw_code(env, "addon_initialization_failed");
        return NULL;
    }
    return exports;
}
