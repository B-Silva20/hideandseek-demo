@echo off
setlocal
cd /d "%~dp0"
where gcc >nul 2>nul
if errorlevel 1 (
  echo 未找到 gcc。请安装 MinGW-w64，或使用项目提供的其他 Windows 编译器。
  exit /b 1
)
gcc -municode -mwindows -O2 -Wall -Wextra -o "虚构推理.exe" launcher.c -lws2_32 -lshell32
if errorlevel 1 (
  echo 启动器编译失败。
  exit /b 1
)
echo 已生成：%CD%\虚构推理.exe
endlocal
