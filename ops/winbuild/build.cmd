@echo off
REM Builds the Windows sharer inside a tb-win VM whose disk carries the
REM toolchain (see ops/winbuild/toolchain.cmd). Sources come from the share
REM (\\host.lan\Data\src, a clean git archive); results go to
REM \\host.lan\Data\out; the result line goes to build-result.txt, which
REM ops/sharer-build-windows.sh waits for. Mirrors the build-windows job of
REM .github/workflows/build-sharer.yml.
setlocal EnableExtensions
set S=\\host.lan\Data
set LOG=%S%\build.log
set RUSTUP_HOME=C:\rust\rustup
set CARGO_HOME=C:\rust\cargo
set VCPKG_ROOT=C:\vcpkg
set VCPKGRS_TRIPLET=x64-windows-static-md
set PATH=C:\rust\cargo\bin;C:\Program Files\nodejs;C:\Program Files\Git\cmd;%PATH%

echo [%date% %time%] build start >> %LOG%
REM Fresh sources; the cargo target dir and node_modules stay for speed.
robocopy %S%\src C:\build\src /MIR /XD target node_modules /NFL /NDL /NJH /NJS /NP >> %LOG% 2>&1
if %errorlevel% GEQ 8 goto fail

cd /d C:\build\src\sharer || goto fail
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Get-Content src-tauri\tauri.conf.json | ConvertFrom-Json).version"`) do set VER=%%v
if "%VER%"=="" goto fail
REM The target dir is kept between builds (and baked into the golden disk);
REM the bundler never clears old installers, so drop them before bundling.
if exist src-tauri\target\release\bundle rmdir /s /q src-tauri\target\release\bundle
call npm ci --no-audit --no-fund >> %LOG% 2>&1 || goto fail
call npm run tauri:build >> %LOG% 2>&1 || goto fail

mkdir %S%\out 2>nul
copy /y src-tauri\target\release\bundle\msi\Auffi_%VER%_x64_en-US.msi %S%\out\ >> %LOG% 2>&1 || goto fail
copy /y src-tauri\target\release\bundle\nsis\Auffi_%VER%_x64-setup.exe %S%\out\ >> %LOG% 2>&1 || goto fail
copy /y src-tauri\target\release\auffi-sharer.exe %S%\out\Auffi_%VER%_x64_portable.exe >> %LOG% 2>&1 || goto fail

echo [%date% %time%] build ok %VER% >> %LOG%
echo RESULT=PASS %VER% > %S%\build-result.txt
exit /b 0

:fail
echo [%date% %time%] build FAILED >> %LOG%
echo RESULT=FAIL > %S%\build-result.txt
exit /b 1
