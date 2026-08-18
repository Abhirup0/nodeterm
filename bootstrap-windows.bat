@echo off
setlocal EnableExtensions
rem =============================================================================================
rem bootstrap-windows.bat — take a fresh Windows checkout to an installed, buildable nodeterm.
rem
rem What it does: verifies the toolchain a native-module Electron build needs (Node >= 20, npm,
rem Visual Studio Build Tools with the C++ workload, Python 3 — node-pty and smart-whisper are
rem compiled against Electron's ABI by the npm `postinstall` hook), then runs `npm ci`.
rem
rem What it does NOT do: install anything machine-wide. Each missing tool is reported with the
rem exact winget command to run — installs that touch Program Files are a decision for the
rem human at the keyboard, not for a bootstrap script.
rem
rem Invoke by ABSOLUTE path from automation (cmd /c "C:\path\to\repo\bootstrap-windows.bat"):
rem on machines with NoDefaultCurrentDirectoryInExePath=1 a relative `cmd /c bootstrap-windows.bat`
rem fails even though the file exists, because cmd refuses to search the current directory.
rem
rem After it succeeds:
rem   npm run dev        - development mode with HMR
rem   npm run dist:win   - unsigned NSIS installer + zip into dist\ (packaging smoke test)
rem =============================================================================================

set "REPO=%~dp0"
if "%REPO:~-1%"=="\" set "REPO=%REPO:~0,-1%"

rem --- Refuse elevation: npm lifecycle scripts must never run as Administrator. ----------------
"%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){exit 86}else{exit 0}" >nul 2>nul
if errorlevel 86 (
    echo [FAILED] Do not run this script as Administrator. Open a normal prompt and rerun.
    exit /b 1
)

echo === nodeterm Windows bootstrap ===
echo Repository: "%REPO%"
echo.

rem --- Node.js >= 20 ----------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [MISSING] Node.js was not found on PATH.
    echo   Install:  winget install OpenJS.NodeJS.LTS
    echo   then open a NEW prompt and rerun this script.
    exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
    echo [FAILED] Node.js ^>= 20 is required; found major version %NODE_MAJOR%.
    echo   Upgrade:  winget install OpenJS.NodeJS.LTS
    exit /b 1
)
echo [OK] Node.js major %NODE_MAJOR%

rem --- Visual Studio Build Tools with the C++ workload (node-gyp / electron-rebuild) ------------
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [MISSING] Visual Studio Build Tools were not found ^(vswhere.exe absent^).
    echo   Install:  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    echo   ^(elevated; then open a NEW prompt and rerun this script^)
    exit /b 1
)
"%VSWHERE%" -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath >nul 2>nul
if errorlevel 1 (
    echo [MISSING] A Visual Studio install exists but lacks the C++ build tools component.
    echo   Install:  winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
    exit /b 1
)
echo [OK] Visual Studio C++ build tools

rem --- Python 3 (node-gyp) -----------------------------------------------------------------------
py -3 --version >nul 2>nul
if errorlevel 1 (
    python --version >nul 2>nul
    if errorlevel 1 (
        echo [MISSING] Python 3 was not found ^(node-gyp needs it^).
        echo   Install:  winget install Python.Python.3.12
        echo   then open a NEW prompt and rerun this script.
        exit /b 1
    )
)
echo [OK] Python 3

rem --- Install dependencies (postinstall patches node-pty + rebuilds native modules) ------------
echo.
echo Running npm ci ...
pushd "%REPO%"
call npm ci
set "NPM_EXIT=%ERRORLEVEL%"
popd
if not "%NPM_EXIT%"=="0" (
    echo [FAILED] npm ci exited with code %NPM_EXIT%. See the output above.
    exit /b %NPM_EXIT%
)

echo.
echo [DONE] Dependencies installed and native modules rebuilt against Electron's ABI.
echo   npm run dev        - development mode with HMR
echo   npm run dist:win   - unsigned NSIS installer + zip into dist\
exit /b 0
