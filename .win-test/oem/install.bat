@echo off
setlocal EnableDelayedExpansion
REM dockur /oem: laeuft nach der Windows-OOBE automatisch als Administrator.
REM Auffi-Installer-Smoke: MSI still installieren, auffi-sharer.exe starten, Prozess +
REM Debug-Log pruefen. Ergebnis -> \\host.lan\Data -> share/install-result.txt.
set "RES=\\host.lan\Data\install-result.txt"
set "MSI=\\host.lan\Data\Auffi_0.6.7_x64_en-US.msi"
set "MSILOG=\\host.lan\Data\msi-log.txt"
set "FAILED=0"

> "%RES%" echo ===== Auffi 0.6.7 Windows-Installer-Smoke =====
>> "%RES%" echo Start: %date% %time%
>> "%RES%" echo.

>> "%RES%" echo [1/5] MSI still installieren (msiexec /qn) ...
msiexec /i "%MSI%" /qn /norestart /L*V "%MSILOG%"
set "MEC=!errorlevel!"
>> "%RES%" echo   msiexec exit=!MEC!
if not "!MEC!"=="0" if not "!MEC!"=="3010" ( >> "%RES%" echo FEHLER: MSI-Install fehlgeschlagen & set FAILED=1 & goto :done )

>> "%RES%" echo [2/5] Installierte auffi-sharer.exe finden ...
set "EXE="
for %%P in ("%ProgramFiles%\Auffi\auffi-sharer.exe" "%ProgramFiles(x86)%\Auffi\auffi-sharer.exe") do (
    if exist "%%~P" set "EXE=%%~P"
)
if "!EXE!"=="" ( >> "%RES%" echo FEHLER: auffi-sharer.exe nach Install nicht gefunden & set FAILED=1 & goto :done )
>> "%RES%" echo   gefunden: !EXE!
for %%F in ("!EXE!") do >> "%RES%" echo   groesse: %%~zF bytes

>> "%RES%" echo [3/5] Auffi starten ...
start "" /b "!EXE!"
timeout /t 25 /nobreak >nul

>> "%RES%" echo [4/5] Prozess laeuft? ...
tasklist /FI "IMAGENAME eq auffi-sharer.exe" 2>nul | find /I "auffi-sharer.exe" >nul
if "!errorlevel!"=="0" ( >> "%RES%" echo   auffi-sharer.exe LAEUFT ) else ( >> "%RES%" echo FEHLER: auffi-sharer.exe laeuft nicht & set FAILED=1 )

>> "%RES%" echo [5/5] Debug-Log (%TEMP%\auffi-debug.log) — Init-Beweis ...
if exist "%TEMP%\auffi-debug.log" (
    >> "%RES%" echo   --- auffi-debug.log ---
    type "%TEMP%\auffi-debug.log" >> "%RES%" 2>&1
    >> "%RES%" echo   --- ende ---
) else ( >> "%RES%" echo   ^(kein Debug-Log - App evtl. noch im Portal-Init^) )

taskkill /F /IM auffi-sharer.exe >nul 2>&1

REM ---- Portable-Test (nur wenn die Portable-Exe in der share liegt) ----
set "PORT=\\host.lan\Data\Auffi_0.6.7_x64_portable.exe"
if not exist "%PORT%" (
    >> "%RES%" echo.
    >> "%RES%" echo [portable] uebersprungen — %PORT% nicht vorhanden ^(CI noch nicht fertig^)
    goto REM ---- NSIS-Setup-Test (nur wenn die setup.exe in der share liegt) ----
set "NSIS=\\host.lan\Data\Auffi_0.6.7_x64-setup.exe"
if not exist "%NSIS%" (
    >> "%RES%" echo.
    >> "%RES%" echo [nsis] uebersprungen — %NSIS% nicht vorhanden
    goto :done
)
>> "%RES%" echo.
>> "%RES%" echo [nsis 1/4] MSI-Installation entfernen, damit sich die Installer nicht ueberlagern ...
msiexec /x "%MSI%" /qn /norestart >nul 2>&1
>> "%RES%" echo [nsis 2/4] setup.exe still installieren ^(/S^) ...
"%NSIS%" /S
timeout /t 20 /nobreak >nul
set "NEXE="
for %%P in ("%ProgramFiles%\Auffi\auffi-sharer.exe" "%ProgramFiles(x86)%\Auffi\auffi-sharer.exe" "%LOCALAPPDATA%\Auffi\auffi-sharer.exe") do (
    if exist "%%~P" set "NEXE=%%~P"
)
if "!NEXE!"=="" ( >> "%RES%" echo FEHLER: auffi-sharer.exe nach NSIS-Install nicht gefunden & set FAILED=1 & goto :done )
>> "%RES%" echo   gefunden: !NEXE!
>> "%RES%" echo [nsis 3/4] starten ...
del "%TEMP%\auffi-debug.log" >nul 2>&1
start "" /b "!NEXE!"
timeout /t 25 /nobreak >nul
>> "%RES%" echo [nsis 4/4] Prozess laeuft? ...
tasklist /FI "IMAGENAME eq auffi-sharer.exe" 2>nul | find /I "auffi-sharer.exe" >nul
if "!errorlevel!"=="0" ( >> "%RES%" echo   NSIS-Installation LAEUFT ) else ( >> "%RES%" echo FEHLER: NSIS-Installation laeuft nicht & set FAILED=1 )
taskkill /F /IM auffi-sharer.exe >nul 2>&1

:done
)
>> "%RES%" echo.
>> "%RES%" echo [portable 1/3] Portable lokal kopieren + starten ^(kein Install^) ...
copy /Y "%PORT%" "%TEMP%\Auffi_portable.exe" >nul
del "%TEMP%\auffi-debug.log" >nul 2>&1
start "" /b "%TEMP%\Auffi_portable.exe"
timeout /t 25 /nobreak >nul
>> "%RES%" echo [portable 2/3] Prozess laeuft? ...
tasklist /FI "IMAGENAME eq Auffi_portable.exe" 2>nul | find /I "Auffi_portable.exe" >nul
if "!errorlevel!"=="0" ( >> "%RES%" echo   Portable LAEUFT ) else ( >> "%RES%" echo FEHLER: Portable laeuft nicht & set FAILED=1 )
>> "%RES%" echo [portable 3/3] Debug-Log ...
if exist "%TEMP%\auffi-debug.log" (
    >> "%RES%" echo   --- auffi-debug.log ^(portable^) ---
    type "%TEMP%\auffi-debug.log" >> "%RES%" 2>&1
    >> "%RES%" echo   --- ende ---
) else ( >> "%RES%" echo   ^(kein Debug-Log^) )
taskkill /F /IM Auffi_portable.exe >nul 2>&1

:done
>> "%RES%" echo.
if "!FAILED!"=="0" ( >> "%RES%" echo RESULT=PASS ) else ( >> "%RES%" echo RESULT=FAIL )
>> "%RES%" echo Ende: %date% %time%
endlocal
