#ifndef MO_UNIT_COUNT_RULES_H
#define MO_UNIT_COUNT_RULES_H

#include <shellapi.h>
#include <wchar.h>

#define UCR_MAX_RULES 512
#define UCR_MAX_BYTES 65536
#define UCR_PATH_CAP 32768

enum UnitCountPolicy { UCR_NORMAL, UCR_EXCLUDE_LOADED, UCR_EXCLUDE_ALL };

struct UnitCountRule {
    char id[32];
    int policy;
};

struct UnitCountTable {
    struct UnitCountRule rules[UCR_MAX_RULES];
    int count;
};

static struct UnitCountTable g_unit_count_rules;
static WCHAR g_unit_count_path[UCR_PATH_CAP];
static FILETIME g_unit_count_seen_time;
static DWORD g_unit_count_seen_size;
static DWORD g_unit_count_last_poll;
static int g_unit_count_seen = 0;
static int g_unit_count_pending = 0;

/* 仅在冷启动文件缺失或无效时兜底；有效文件整表替换，不与默认名单叠加。 */
static void unit_count_defaults(struct UnitCountTable *table)
{
    static const struct UnitCountRule defaults[] = {
        { "DRACOD", UCR_EXCLUDE_LOADED },
        { "SALA_1", UCR_EXCLUDE_ALL }, { "SALA_2", UCR_EXCLUDE_ALL },
        { "SUNB_1", UCR_EXCLUDE_ALL }, { "MAGNET_1", UCR_EXCLUDE_ALL },
        { "MAGNET_2", UCR_EXCLUDE_ALL }, { "CYCL_1", UCR_EXCLUDE_ALL },
        { "F_KSNAK", UCR_EXCLUDE_ALL }
    };
    memset(table, 0, sizeof(*table));
    memcpy(table->rules, defaults, sizeof(defaults));
    table->count = (int)(sizeof(defaults) / sizeof(defaults[0]));
}

static char *unit_count_trim(char *s)
{
    char *end;
    while (*s == ' ' || *s == '\t' || *s == '\r') ++s;
    end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r')) --end;
    *end = 0;
    return s;
}

static int unit_count_id(const char *src, char *dst)
{
    size_t n = strlen(src), i;
    if (!n || n >= 32) return 0;
    for (i = 0; i < n; ++i) {
        char c = src[i];
        if (c >= 'a' && c <= 'z') c = (char)(c - 'a' + 'A');
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return 0;
        dst[i] = c;
    }
    dst[n] = 0;
    return 1;
}

static int unit_count_parse(char *data, DWORD size, struct UnitCountTable *table,
                            char *error, size_t error_size)
{
    char *cursor = data;
    int line = 0, section = 0, meta_seen = 0, units_seen = 0, version_seen = 0;
    memset(table, 0, sizeof(*table));
    if (memchr(data, 0, size) || (size && !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
            data, (int)size, NULL, 0))) {
        snprintf(error, error_size, "line 1: expected UTF-8 text without NUL bytes");
        return 0;
    }
    if (size >= 3 && (BYTE)data[0] == 0xEF && (BYTE)data[1] == 0xBB && (BYTE)data[2] == 0xBF)
        cursor += 3;
    while (*cursor) {
        char *next = strchr(cursor, '\n'), *text, *comment, *eq, *key, *value;
        int i, policy;
        char id[32];
        ++line;
        if (next) *next++ = 0;
        text = unit_count_trim(cursor);
        comment = strpbrk(text, ";#");
        if (comment) *comment = 0;
        text = unit_count_trim(text);
        if (!*text) goto next_line;
        if (*text == '[') {
            if (!_stricmp(text, "[meta]") && !meta_seen) {
                section = 1; meta_seen = 1;
            } else if (!_stricmp(text, "[units]") && !units_seen) {
                section = 2; units_seen = 1;
            } else {
                snprintf(error, error_size, "line %d: unknown or duplicate section", line);
                return 0;
            }
            goto next_line;
        }
        eq = strchr(text, '=');
        if (!eq || !section) {
            snprintf(error, error_size, "line %d: expected key=value inside [meta] or [units]", line);
            return 0;
        }
        *eq = 0;
        key = unit_count_trim(text);
        value = unit_count_trim(eq + 1);
        if (section == 1) {
            if (_stricmp(key, "version") || strcmp(value, "1") || version_seen) {
                snprintf(error, error_size, "line %d: expected one version=1", line);
                return 0;
            }
            version_seen = 1;
            goto next_line;
        }
        if (!unit_count_id(key, id)) {
            snprintf(error, error_size, "line %d: ID must be 1..31 ASCII letters, digits or underscores", line);
            return 0;
        }
        if (!_stricmp(value, "normal")) policy = UCR_NORMAL;
        else if (!_stricmp(value, "exclude_loaded")) policy = UCR_EXCLUDE_LOADED;
        else if (!_stricmp(value, "exclude_all")) policy = UCR_EXCLUDE_ALL;
        else {
            snprintf(error, error_size, "line %d: unknown policy '%s'", line, value);
            return 0;
        }
        for (i = 0; i < table->count; ++i) {
            if (!strcmp(table->rules[i].id, id)) {
                snprintf(error, error_size, "line %d: duplicate ID %s", line, id);
                return 0;
            }
        }
        if (table->count == UCR_MAX_RULES) {
            snprintf(error, error_size, "line %d: more than %d rules", line, UCR_MAX_RULES);
            return 0;
        }
        strcpy(table->rules[table->count].id, id);
        table->rules[table->count++].policy = policy;
next_line:
        if (!next) break;
        cursor = next;
    }
    if (!meta_seen || !units_seen || !version_seen) {
        snprintf(error, error_size, "line %d: [meta], version=1 and [units] are required", line ? line : 1);
        return 0;
    }
    return 1;
}

static int unit_count_stat(WIN32_FILE_ATTRIBUTE_DATA *info)
{
    return GetFileAttributesExW(g_unit_count_path, GetFileExInfoStandard, info)
        && !(info->dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY);
}

static int unit_count_load(struct UnitCountTable *table, char *error, size_t error_size)
{
    HANDLE file;
    BY_HANDLE_FILE_INFORMATION before, after;
    DWORD got = 0, size;
    char *data;
    int ok;
    file = CreateFileW(g_unit_count_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                      NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        snprintf(error, error_size, "cannot open configuration (Win32=%lu)", GetLastError());
        return 0;
    }
    if (!GetFileInformationByHandle(file, &before) || before.nFileSizeHigh
            || before.nFileSizeLow > UCR_MAX_BYTES) {
        snprintf(error, error_size, "cannot read configuration or file exceeds %d bytes", UCR_MAX_BYTES);
        CloseHandle(file);
        return 0;
    }
    size = before.nFileSizeLow;
    data = (char *)malloc((size_t)size + 1);
    if (!data) {
        snprintf(error, error_size, "out of memory");
        CloseHandle(file);
        return 0;
    }
    ok = ReadFile(file, data, size, &got, NULL) && got == size
        && GetFileInformationByHandle(file, &after)
        && before.nFileSizeHigh == after.nFileSizeHigh && before.nFileSizeLow == after.nFileSizeLow
        && !CompareFileTime(&before.ftLastWriteTime, &after.ftLastWriteTime);
    CloseHandle(file);
    data[size] = 0;
    if (ok) ok = unit_count_parse(data, size, table, error, error_size);
    else snprintf(error, error_size, "configuration changed during read; save again to retry");
    free(data);
    return ok;
}

static const char *unit_count_policy_name(int policy)
{
    if (policy == UCR_EXCLUDE_LOADED) return "exclude_loaded";
    if (policy == UCR_EXCLUDE_ALL) return "exclude_all";
    return "normal";
}

/* 参数单独按 UTF-16 读取，避免中文规则路径经 main 的 ANSI argv 丢失。 */
static int unit_count_path(int *check)
{
    WCHAR **args;
    int argc = 0, i, specified = 0;
    DWORD n;
    args = CommandLineToArgvW(GetCommandLineW(), &argc);
    *check = 0;
    if (!args) return 0;
    for (i = 1; i < argc; ++i) {
        int is_check = !wcscmp(args[i], L"--check-unit-count-rules");
        if (is_check || !wcscmp(args[i], L"--unit-count-rules")) {
            if (specified || i + 1 >= argc || !args[i + 1][0] || !wcsncmp(args[i + 1], L"--", 2)) {
                fprintf(stderr, "unit-count: expected one rule path after --unit-count-rules or --check-unit-count-rules\n");
                LocalFree(args);
                return 0;
            }
            *check = is_check;
            specified = 1;
            n = GetFullPathNameW(args[++i], UCR_PATH_CAP, g_unit_count_path, NULL);
            if (!n || n >= UCR_PATH_CAP) { LocalFree(args); return 0; }
        }
    }
    LocalFree(args);
    if (!specified) {
        WCHAR *slash;
        n = GetModuleFileNameW(NULL, g_unit_count_path, UCR_PATH_CAP);
        if (!n || n >= UCR_PATH_CAP) return 0;
        slash = wcsrchr(g_unit_count_path, L'\\');
        if (!slash || (size_t)(slash - g_unit_count_path) + 22 >= UCR_PATH_CAP) return 0;
        wcscpy(slash + 1, L"unit_count_rules.ini");
    }
    return 1;
}

static void unit_count_log_path(void)
{
    char *path;
    int n = WideCharToMultiByte(CP_UTF8, 0, g_unit_count_path, -1, NULL, 0, NULL, NULL);
    path = n ? (char *)malloc(n) : NULL;
    if (path) {
        WideCharToMultiByte(CP_UTF8, 0, g_unit_count_path, -1, path, n, NULL, NULL);
        printf("unit-count: path=%s\n", path);
        free(path);
    }
}

static int unit_count_check(void)
{
    static struct UnitCountTable candidate;
    char error[256];
    int i;
    unit_count_log_path();
    if (!unit_count_load(&candidate, error, sizeof(error))) {
        fprintf(stderr, "unit-count: %s\n", error);
        return 2;
    }
    printf("unit-count: valid version=1 rules=%d\n", candidate.count);
    for (i = 0; i < candidate.count; ++i)
        printf("%s=%s\n", candidate.rules[i].id, unit_count_policy_name(candidate.rules[i].policy));
    return 0;
}

static void unit_count_start(void)
{
    static struct UnitCountTable candidate;
    WIN32_FILE_ATTRIBUTE_DATA info;
    char error[256];
    unit_count_defaults(&g_unit_count_rules);
    unit_count_log_path();
    if (unit_count_load(&candidate, error, sizeof(error))) {
        g_unit_count_rules = candidate;
        printf("unit-count: loaded %d rules\n", candidate.count);
    } else {
        printf("unit-count: warning: %s; using built-in defaults (%d rules)\n", error, g_unit_count_rules.count);
    }
    g_unit_count_seen = unit_count_stat(&info);
    if (g_unit_count_seen) {
        g_unit_count_seen_time = info.ftLastWriteTime;
        g_unit_count_seen_size = info.nFileSizeLow;
    }
    g_unit_count_last_poll = GetTickCount();
    g_unit_count_pending = 0;
    fflush(stdout);
}

/* 连续两次检查文件稳定后加载；只在一帧采集前整体换表，错误时保留上一份规则。 */
static void unit_count_poll(void)
{
    static struct UnitCountTable candidate;
    WIN32_FILE_ATTRIBUTE_DATA info;
    DWORD now = GetTickCount();
    char error[256];
    if ((DWORD)(now - g_unit_count_last_poll) < 1000) return;
    g_unit_count_last_poll = now;
    if (!unit_count_stat(&info)) {
        if (g_unit_count_seen) {
            printf("unit-count: warning: configuration unavailable; keeping active rules\n");
            fflush(stdout);
        }
        g_unit_count_seen = 0;
        g_unit_count_pending = 0;
        return;
    }
    if (!g_unit_count_seen || CompareFileTime(&g_unit_count_seen_time, &info.ftLastWriteTime)
            || g_unit_count_seen_size != info.nFileSizeLow || info.nFileSizeHigh) {
        g_unit_count_seen = 1;
        g_unit_count_seen_time = info.ftLastWriteTime;
        g_unit_count_seen_size = info.nFileSizeLow;
        g_unit_count_pending = 1;
        return;
    }
    if (!g_unit_count_pending) return;
    g_unit_count_pending = 0;
    if (unit_count_load(&candidate, error, sizeof(error))) {
        g_unit_count_rules = candidate;
        printf("unit-count: reloaded %d rules\n", candidate.count);
    } else {
        printf("unit-count: warning: %s; keeping active rules\n", error);
    }
    fflush(stdout);
}

static int unit_count_excluded(const char *id, int limbo, DWORD carrier)
{
    char normalized[32];
    int i;
    if (!unit_count_id(id, normalized)) return 0;
    for (i = 0; i < g_unit_count_rules.count; ++i) {
        const struct UnitCountRule *rule = &g_unit_count_rules.rules[i];
        if (strcmp(rule->id, normalized)) continue;
        return rule->policy == UCR_EXCLUDE_ALL
            || (rule->policy == UCR_EXCLUDE_LOADED && limbo && carrier);
    }
    return 0;
}

#endif
