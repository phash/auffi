@echo off
REM One-time toolchain install for building the Windows sharer in a tb-win VM.
REM Runs in a throw-away copy of the golden disk; ops/sharer-build-windows.sh
REM --toolchain then promotes that copy to the new golden disk, so every later
REM build run starts with the tools in place. The build itself runs afterwards
REM in a fresh copy, so a build failure never throws away the hour of installs.
REM Versions match .github/workflows/build-sharer.yml (Rust 1.99.1, Node 22,
REM vcpkg libvpx x64-windows-static-md, VS 2022 C++ build tools).
setlocal EnableExtensions
set S=\\host.lan\Data
set LOG=%S%\toolchain.log
set D=C:\tb\dl
mkdir %D% 2>nul
echo [%date% %time%] toolchain start > %LOG%

REM Defender scanning every object file doubles a Rust build.
powershell -NoProfile -Command "Add-MpPreference -ExclusionPath 'C:\build','C:\rust','C:\vcpkg'" >> %LOG% 2>&1

REM WiX 3 (Tauri's MSI bundler) runs VBScript custom actions; 24H2 ships it as an optional feature.
REM dism writes UTF-16; keep it out of the log.
dism /Online /Add-Capability /CapabilityName:VBSCRIPT~~~~ /NoRestart >nul 2>&1

echo [%date% %time%] vs build tools >> %LOG%
curl.exe -fsSL -o %D%\vs_buildtools.exe https://aka.ms/vs/17/release/vs_buildtools.exe || goto fail
%D%\vs_buildtools.exe --quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.Windows11SDK.22621 >> %LOG% 2>&1
set RC=%errorlevel%
if not "%RC%"=="0" if not "%RC%"=="3010" goto fail

echo [%date% %time%] node >> %LOG%
curl.exe -fsSL -o %D%\node.msi https://nodejs.org/dist/v22.23.5/node-v22.23.5-x64.msi || goto fail
msiexec /i %D%\node.msi /qn /norestart >> %LOG% 2>&1 || goto fail

echo [%date% %time%] git >> %LOG%
curl.exe -fsSL -o %D%\git.exe https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/Git-2.56.1-64-bit.exe || goto fail
%D%\git.exe /VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES >> %LOG% 2>&1 || goto fail

echo [%date% %time%] rust >> %LOG%
setx /M RUSTUP_HOME C:\rust\rustup >> %LOG% 2>&1
setx /M CARGO_HOME C:\rust\cargo >> %LOG% 2>&1
set RUSTUP_HOME=C:\rust\rustup
set CARGO_HOME=C:\rust\cargo
curl.exe -fsSL -o %D%\rustup-init.exe https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe || goto fail
REM rustup-init can exit non-zero on "timeout reading rustc version" (first
REM rustc start under Defender) although the toolchain is in place; judge by
REM rustc itself instead of the installer's exit code.
%D%\rustup-init.exe -y --profile minimal --default-toolchain 1.99.1 --no-modify-path >> %LOG% 2>&1
set N=0
:rustc
C:\rust\cargo\bin\rustc.exe --version >> %LOG% 2>&1 && goto rustok
set /a N+=1
if %N% GEQ 5 goto fail
timeout /t 15 /nobreak >nul
goto rustc
:rustok

echo [%date% %time%] vcpkg + libvpx >> %LOG%
curl.exe -fsSL -o %D%\vcpkg.zip https://github.com/microsoft/vcpkg/archive/refs/tags/2026.10.16.zip || goto fail
tar.exe -xf %D%\vcpkg.zip -C C:\ >> %LOG% 2>&1 || goto fail
move C:\vcpkg-2026.10.16 C:\vcpkg >> %LOG% 2>&1 || goto fail
call C:\vcpkg\bootstrap-vcpkg.bat -disableMetrics >> %LOG% 2>&1 || goto fail
C:\vcpkg\vcpkg.exe install libvpx:x64-windows-static-md >> %LOG% 2>&1 || goto fail
setx /M VCPKG_ROOT C:\vcpkg >> %LOG% 2>&1

echo [%date% %time%] machine PATH >> %LOG%
powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('Path','Machine'); foreach($d in 'C:\rust\cargo\bin','C:\vcpkg'){ if($p -notlike ('*'+$d+'*')){ $p=$p+';'+$d } }; [Environment]::SetEnvironmentVariable('Path',$p,'Machine')" >> %LOG% 2>&1

del %D%\*.exe %D%\*.msi %D%\*.zip 2>nul
REM Let the next copy of this disk run its project's install.bat again.
del C:\tb\done.flag
echo [%date% %time%] toolchain ok >> %LOG%
echo RESULT=PASS > %S%\toolchain-result.txt
shutdown /s /t 20
exit /b 0

:fail
echo [%date% %time%] toolchain FAILED >> %LOG%
echo RESULT=FAIL > %S%\toolchain-result.txt
exit /b 1
