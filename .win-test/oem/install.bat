@echo off
setlocal
REM dockur /oem: laeuft EINMAL nach der Windows-OOBE als Administrator.
REM Einzige Aufgabe: den Smoke wiederholbar machen. Der eigentliche Test liegt in
REM oem/smoke.bat, das ueber die Host-Freigabe eingebunden ist (\\host.lan\Data\oem)
REM und damit bei jedem Boot in der aktuellen Fassung laeuft - ohne Neuinstallation
REM von Windows. Ein Logon-Task startet ihn bei jedem Boot; danach laeuft er hier
REM einmal sofort.
set "SMOKE=\\host.lan\Data\oem\smoke.bat"
set "LOG=\\host.lan\Data\first-boot.txt"

> "%LOG%" echo first boot: %date% %time%
schtasks /Create /F /TN AuffiSmoke /SC ONLOGON /RL HIGHEST /TR "cmd.exe /c %SMOKE%" >> "%LOG%" 2>&1
>> "%LOG%" echo schtasks exit=%errorlevel%

if exist "%SMOKE%" (
    >> "%LOG%" echo smoke.bat gefunden - erster Lauf
    call "%SMOKE%"
) else (
    >> "%LOG%" echo FEHLER: %SMOKE% nicht erreichbar - oem/ nicht unter /data/oem gemountet?
)
endlocal
