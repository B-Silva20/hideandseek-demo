#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>
#include <stdio.h>

static void show_error(const wchar_t *title, const wchar_t *message) {
    MessageBoxW(NULL, message, title, MB_OK | MB_ICONERROR);
}

static int file_exists(const wchar_t *path) {
    DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

static void get_exe_directory(wchar_t *directory, DWORD capacity) {
    DWORD length = GetModuleFileNameW(NULL, directory, capacity);
    if (!length || length >= capacity) {
        directory[0] = L'\0';
        return;
    }
    wchar_t *slash = wcsrchr(directory, L'\\');
    if (slash) *slash = L'\0';
}

static int port_is_open(int port) {
    WSADATA winsock;
    if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) {
        return 0;
    }

    SOCKET socket_handle = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket_handle == INVALID_SOCKET) {
        WSACleanup();
        return 0;
    }

    struct sockaddr_in address = { 0 };
    address.sin_family = AF_INET;
    address.sin_port = htons((u_short)port);
    InetPtonW(AF_INET, L"127.0.0.1", &address.sin_addr);

    int connected = connect(socket_handle, (struct sockaddr *)&address, sizeof(address)) == 0;
    closesocket(socket_handle);
    WSACleanup();
    return connected;
}

static int start_project(const wchar_t *directory, const wchar_t *runtime_node, PROCESS_INFORMATION *process) {
    // 发布包直接运行内置 Node；CREATE_NO_WINDOW 保证不会出现 cmd 或 Node 控制台。
    wchar_t command[] = L"runtime\\node.exe dist-server\\index.js";
    STARTUPINFOW startup = { 0 };
    startup.cb = sizeof(startup);
    ZeroMemory(process, sizeof(*process));
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    return CreateProcessW(runtime_node, command, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, directory, &startup, process);
}

static int find_browser(wchar_t *browser, DWORD capacity) {
    wchar_t program_files[MAX_PATH] = L"";
    wchar_t program_files_x86[MAX_PATH] = L"";
    GetEnvironmentVariableW(L"ProgramFiles", program_files, _countof(program_files));
    GetEnvironmentVariableW(L"ProgramFiles(x86)", program_files_x86, _countof(program_files_x86));
    const wchar_t *roots[] = { program_files, program_files_x86, L"C:\\Program Files", L"C:\\Program Files (x86)" };
    const wchar_t *suffixes[] = { L"\\Google\\Chrome\\Application\\chrome.exe", L"\\Microsoft\\Edge\\Application\\msedge.exe" };
    for (size_t root = 0; root < _countof(roots); ++root) {
        if (!roots[root][0]) continue;
        for (size_t suffix = 0; suffix < _countof(suffixes); ++suffix) {
            _snwprintf(browser, capacity, L"%ls%ls", roots[root], suffixes[suffix]);
            if (file_exists(browser)) return 1;
        }
    }
    return 0;
}

static int start_game_window(const wchar_t *directory, PROCESS_INFORMATION *process) {
    wchar_t browser[MAX_PATH];
    if (!find_browser(browser, _countof(browser))) return 0;
    // 独立配置目录使 --app 窗口有自己的进程生命周期；关闭该窗口即可可靠结束后端。
    wchar_t profile[MAX_PATH];
    _snwprintf(profile, _countof(profile), L"%ls\\.browser-profile", directory);
    CreateDirectoryW(profile, NULL);
    wchar_t command[2048];
    _snwprintf(command, _countof(command), L"\"%ls\" --app=http://127.0.0.1:3001 --no-first-run --no-default-browser-check --user-data-dir=\"%ls\"", browser, profile);
    STARTUPINFOW startup = { 0 };
    startup.cb = sizeof(startup);
    ZeroMemory(process, sizeof(*process));
    return CreateProcessW(browser, command, NULL, NULL, FALSE, 0, NULL, directory, &startup, process);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show_command;

    wchar_t directory[MAX_PATH];
    get_exe_directory(directory, _countof(directory));
    if (!directory[0]) {
        show_error(L"虚构推理", L"无法确定启动器所在目录。请把 EXE 放在项目根目录后重试。");
        return 1;
    }

    // 发布包不需要 package.json；只检查发布运行所需的内置 Runtime 和构建产物。
    wchar_t runtime_node[MAX_PATH];
    wchar_t server_entry[MAX_PATH];
    wchar_t frontend_entry[MAX_PATH];
    _snwprintf(runtime_node, _countof(runtime_node), L"%ls\\runtime\\node.exe", directory);
    _snwprintf(server_entry, _countof(server_entry), L"%ls\\dist-server\\index.js", directory);
    _snwprintf(frontend_entry, _countof(frontend_entry), L"%ls\\dist\\index.html", directory);
    if (!file_exists(runtime_node) || !file_exists(server_entry) || !file_exists(frontend_entry)) {
        show_error(L"虚构推理", L"发布包文件不完整。请确认 EXE 与 runtime、dist-server、dist 文件夹保持同级，不要单独移动 EXE。");
        return 1;
    }

    PROCESS_INFORMATION server = { 0 };
    int server_started_here = 0;
    if (!port_is_open(3001)) {
        if (!start_project(directory, runtime_node, &server)) {
            show_error(L"虚构推理", L"项目启动失败。请确认发布包中的 runtime、dist-server 和 node_modules 文件夹完整。");
            return 1;
        }
        CloseHandle(server.hThread);
        server_started_here = 1;

        int ready = 0;
        for (int attempt = 0; attempt < 60; ++attempt) {
            Sleep(500);
            if (port_is_open(3001)) {
                ready = 1;
                break;
            }
        }
        if (!ready) {
            TerminateProcess(server.hProcess, 0);
            CloseHandle(server.hProcess);
            show_error(L"虚构推理", L"项目启动超时。请确认发布包文件完整，且 3001 端口未被其他程序占用。");
            return 1;
        }
    }

    PROCESS_INFORMATION browser = { 0 };
    if (!start_game_window(directory, &browser)) {
        if (server_started_here) { TerminateProcess(server.hProcess, 0); CloseHandle(server.hProcess); }
        show_error(L"虚构推理", L"未找到可用浏览器。请安装 Chrome 或 Microsoft Edge 后重试。");
        return 1;
    }
    CloseHandle(browser.hThread);
    if (server_started_here) {
        // 启动器没有可见窗口，但保持自身存活以等待独立游戏窗口关闭。
        // 一旦窗口关闭，结束本次启动的 Node，避免后台服务残留。
        WaitForSingleObject(browser.hProcess, INFINITE);
        TerminateProcess(server.hProcess, 0);
        WaitForSingleObject(server.hProcess, 3000);
        CloseHandle(server.hProcess);
        CloseHandle(browser.hProcess);
    } else {
        CloseHandle(browser.hProcess);
    }
    return 0;
}
