@echo off
REM Builds the Windows sharer inside a tb-win VM whose disk carries the
REM toolchain (see ops/winbuild/toolchain.cmd). Sources come from the share
REM (\\host.lan\Data\src, a clean git archive); results go to
REM \\host.lan\Data\out; the result line goes to build-result.txt, which
REM ops/sharer-build-windows.sh waits for. Mirrors the build-windows job of
REM .github/workflows/build-sharer.yml.
setlocal EnableExtensions
set S=\\host.lan\Data
REM Not LOG: the MSVC environment scripts reuse that name, and every later
REM line of this log vanished after vcvars64.
set BLOG=%S%\build.log
set RUSTUP_HOME=C:\rust\rustup
set CARGO_HOME=C:\rust\cargo
set VCPKG_ROOT=C:\vcpkg
set VCPKGRS_TRIPLET=x64-windows-static-md
set PATH=C:\rust\cargo\bin;C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%
REM The MSVC developer environment puts rc.exe (Windows SDK) on PATH; Tauri's
REM resource step (tauri-winres) needs it. CI runners preload it, a VM does not.
set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -property installationPath`) do set VSDIR=%%i
if not defined VSDIR set "VSDIR=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
set STEP=vcvars
if not exist "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" goto fail
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >> %BLOG% 2>&1
set STEP=rc.exe
where rc.exe >> %BLOG% 2>&1 || goto fail

echo [%date% %time%] build start >> %BLOG%
REM Fresh sources; the cargo target dir and node_modules stay for speed.
set STEP=robocopy
robocopy %S%\src C:\build\src /MIR /XD target node_modules /NFL /NDL /NJH /NJS /NP >> %BLOG% 2>&1
if %errorlevel% GEQ 8 goto fail

set STEP=version
cd /d C:\build\src\sharer || goto fail
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content src-tauri\tauri.conf.json | ConvertFrom-Json).version"`) do set VER=%%v
if "%VER%"=="" goto fail
REM The target dir is kept between builds (and baked into the golden disk);
REM the bundler never clears old installers, so drop them before bundling.
if exist src-tauri\target\release\bundle rmdir /s /q src-tauri\target\release\bundle
set STEP=npm-ci
call npm ci --no-audit --no-fund >> %BLOG% 2>&1 || goto fail
set STEP=tauri-build
call npm run tauri:build >> %BLOG% 2>&1 || goto fail

set STEP=copy
mkdir %S%\out 2>nul
copy /y src-tauri\target\release\bundle\msi\Auffi_%VER%_x64_en-US.msi %S%\out\ >> %BLOG% 2>&1 || goto fail
copy /y src-tauri\target\release\bundle\nsis\Auffi_%VER%_x64-setup.exe %S%\out\ >> %BLOG% 2>&1 || goto fail
copy /y src-tauri\target\release\auffi-sharer.exe %S%\out\Auffi_%VER%_x64_portable.exe >> %BLOG% 2>&1 || goto fail

echo [%date% %time%] build ok %VER% >> %BLOG%
echo RESULT=PASS %VER% > %S%\build-result.txt
exit /b 0

:fail
echo [%date% %time%] build FAILED at %STEP% >> %BLOG%
REM The step goes to the result file too: it lands even when the log does not.
echo RESULT=FAIL step=%STEP% > %S%\build-result.txt
exit /b 1
