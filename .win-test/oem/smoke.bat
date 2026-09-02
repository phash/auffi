@echo off
setlocal EnableDelayedExpansion
REM Auffi Windows-Installer-Smoke. Laeuft bei jedem Boot (Logon-Task aus install.bat)
REM und liest die zu pruefende Version aus \\host.lan\Data\version.txt (schreibt
REM run.sh). Prueft MSI, Portable und NSIS-Setup: still installieren, starten,
REM Prozess lebt, Binary traegt die erwartete Version. Ergebnis -> install-result.txt.
set "SHARE=\\host.lan\Data"
set "RES=%SHARE%\install-result.txt"
set "MSILOG=%SHARE%\msi-log.txt"
set "FAILED=0"

REM Die Freigabe ist beim Logon nicht immer sofort da.
set /a TRIES=0
:waitshare
if exist "%SHARE%\version.txt" goto :haveshare
set /a TRIES+=1
if !TRIES! GEQ 45 goto :haveshare
ping -n 3 127.0.0.1 >nul
goto :waitshare
:haveshare

set "VER="
if exist "%SHARE%\version.txt" set /p VER=<"%SHARE%\version.txt"
if "!VER!"=="" (
    for %%F in ("%SHARE%\Auffi_*_x64_en-US.msi") do (
        set "VER=%%~nF"
        set "VER=!VER:Auffi_=!"
        set "VER=!VER:_x64_en-US=!"
    )
)
if "!VER!"=="" (
    > "%RES%" echo ===== Auffi Windows-Installer-Smoke =====
    >> "%RES%" echo FEHLER: keine Version - weder version.txt noch Auffi_*_x64_en-US.msi in der Freigabe
    >> "%RES%" echo RESULT=SKIP
    goto :eof
)

set "MSI=%SHARE%\Auffi_!VER!_x64_en-US.msi"
set "PORT=%SHARE%\Auffi_!VER!_x64_portable.exe"
set "NSIS=%SHARE%\Auffi_!VER!_x64-setup.exe"

> "%RES%" echo ===== Auffi !VER! Windows-Installer-Smoke =====
>> "%RES%" echo Start: %date% %time%
for /f "usebackq delims=" %%W in (`ver`) do >> "%RES%" echo Windows: %%W
>> "%RES%" echo.

REM Reste des letzten Laufs entfernen, damit die Installer sich nicht ueberlagern.
taskkill /F /IM auffi-sharer.exe >nul 2>&1
taskkill /F /IM Auffi_portable.exe >nul 2>&1
if exist "%LOCALAPPDATA%\Auffi\uninstall.exe" (
    >> "%RES%" echo [prep] alte NSIS-Installation entfernen ...
    "%LOCALAPPDATA%\Auffi\uninstall.exe" /S
    ping -n 16 127.0.0.1 >nul
)
del "%TEMP%\auffi-debug.log" >nul 2>&1

REM ---------------------------------------------------------------- MSI
if not exist "%MSI%" (
    >> "%RES%" echo [msi] FEHLER: %MSI% nicht vorhanden
    set FAILED=1
    goto :portable
)
>> "%RES%" echo [msi 1/5] still installieren (msiexec /qn) ...
msiexec /i "%MSI%" /qn /norestart /L*V "%MSILOG%"
set "MEC=!errorlevel!"
>> "%RES%" echo   msiexec exit=!MEC!
if not "!MEC!"=="0" if not "!MEC!"=="3010" (
    >> "%RES%" echo   FEHLER: MSI-Install fehlgeschlagen
    set FAILED=1
    goto :portable
)
>> "%RES%" echo [msi 2/5] installierte auffi-sharer.exe finden ...
set "EXE="
for %%P in ("%ProgramFiles%\Auffi\auffi-sharer.exe" "%ProgramFiles(x86)%\Auffi\auffi-sharer.exe") do (
    if exist "%%~P" set "EXE=%%~P"
)
if "!EXE!"=="" (
    >> "%RES%" echo   FEHLER: auffi-sharer.exe nach Install nicht gefunden
    set FAILED=1
    goto :portable
)
>> "%RES%" echo   gefunden: !EXE!
for %%F in ("!EXE!") do >> "%RES%" echo   groesse: %%~zF bytes
call :checkver "!EXE!"
>> "%RES%" echo [msi 3/5] starten ...
start "" /b "!EXE!"
ping -n 26 127.0.0.1 >nul
>> "%RES%" echo [msi 4/5] Prozess laeuft? ...
tasklist /FI "IMAGENAME eq auffi-sharer.exe" 2>nul | find /I "auffi-sharer.exe" >nul
if "!errorlevel!"=="0" (
    >> "%RES%" echo   auffi-sharer.exe LAEUFT
) else (
    >> "%RES%" echo   FEHLER: auffi-sharer.exe laeuft nicht
    set FAILED=1
)
>> "%RES%" echo [msi 5/5] Debug-Log ...
call :dumplog
taskkill /F /IM auffi-sharer.exe >nul 2>&1

REM ------------------------------------------------------------ Portable
:portable
>> "%RES%" echo.
if not exist "%PORT%" (
    >> "%RES%" echo [portable] uebersprungen - %PORT% nicht vorhanden
    goto :nsis
)
>> "%RES%" echo [portable 1/3] lokal kopieren und starten (kein Install) ...
copy /Y "%PORT%" "%TEMP%\Auffi_portable.exe" >nul
call :checkver "%TEMP%\Auffi_portable.exe"
del "%TEMP%\auffi-debug.log" >nul 2>&1
start "" /b "%TEMP%\Auffi_portable.exe"
ping -n 26 127.0.0.1 >nul
>> "%RES%" echo [portable 2/3] Prozess laeuft? ...
tasklist /FI "IMAGENAME eq Auffi_portable.exe" 2>nul | find /I "Auffi_portable.exe" >nul
if "!errorlevel!"=="0" (
    >> "%RES%" echo   Portable LAEUFT
) else (
    >> "%RES%" echo   FEHLER: Portable laeuft nicht
    set FAILED=1
)
>> "%RES%" echo [portable 3/3] Debug-Log ...
call :dumplog
taskkill /F /IM Auffi_portable.exe >nul 2>&1

REM ---------------------------------------------------------------- NSIS
:nsis
>> "%RES%" echo.
if not exist "%NSIS%" (
    >> "%RES%" echo [nsis] uebersprungen - %NSIS% nicht vorhanden
    goto :done
)
>> "%RES%" echo [nsis 1/4] MSI-Installation entfernen, damit sich die Installer nicht ueberlagern ...
if exist "%MSI%" msiexec /x "%MSI%" /qn /norestart >nul 2>&1
>> "%RES%" echo [nsis 2/4] setup.exe still installieren (/S) ...
"%NSIS%" /S
ping -n 21 127.0.0.1 >nul
set "NEXE="
for %%P in ("%ProgramFiles%\Auffi\auffi-sharer.exe" "%ProgramFiles(x86)%\Auffi\auffi-sharer.exe" "%LOCALAPPDATA%\Auffi\auffi-sharer.exe") do (
    if exist "%%~P" set "NEXE=%%~P"
)
if "!NEXE!"=="" (
    >> "%RES%" echo   FEHLER: auffi-sharer.exe nach NSIS-Install nicht gefunden
    set FAILED=1
    goto :done
)
>> "%RES%" echo   gefunden: !NEXE!
call :checkver "!NEXE!"
>> "%RES%" echo [nsis 3/4] starten ...
del "%TEMP%\auffi-debug.log" >nul 2>&1
start "" /b "!NEXE!"
ping -n 26 127.0.0.1 >nul
>> "%RES%" echo [nsis 4/4] Prozess laeuft? ...
tasklist /FI "IMAGENAME eq auffi-sharer.exe" 2>nul | find /I "auffi-sharer.exe" >nul
if "!errorlevel!"=="0" (
    >> "%RES%" echo   NSIS-Installation LAEUFT
) else (
    >> "%RES%" echo   FEHLER: NSIS-Installation laeuft nicht
    set FAILED=1
)
call :dumplog
REM Mit keep-running in der Freigabe bleibt die letzte Instanz fuer noVNC offen.
if not exist "%SHARE%\keep-running" taskkill /F /IM auffi-sharer.exe >nul 2>&1

:done
>> "%RES%" echo.
if "!FAILED!"=="0" (
    >> "%RES%" echo RESULT=PASS
) else (
    >> "%RES%" echo RESULT=FAIL
)
>> "%RES%" echo Ende: %date% %time%
endlocal
goto :eof

REM ---- Unterprogramme ------------------------------------------------------
:checkver
REM Beweist, dass das gestartete Binary die erwartete Version traegt - sonst
REM testet man still einen alten Installer.
set "EXEVER="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -Command "(Get-Item '%~1').VersionInfo.ProductVersion"`) do set "EXEVER=%%V"
echo !EXEVER!| findstr /B /C:"!VER!" >nul
if "!errorlevel!"=="0" (
    >> "%RES%" echo   version: !EXEVER!
) else (
    >> "%RES%" echo   FEHLER: Binary meldet Version "!EXEVER!", erwartet !VER!
    set FAILED=1
)
goto :eof

:dumplog
if exist "%TEMP%\auffi-debug.log" (
    >> "%RES%" echo   --- auffi-debug.log ---
    type "%TEMP%\auffi-debug.log" >> "%RES%" 2>&1
    >> "%RES%" echo   --- ende ---
) else (
    >> "%RES%" echo   kein Debug-Log - App hat in 25 s nichts geloggt, Capture/Connect nicht abgedeckt
)
goto :eof
