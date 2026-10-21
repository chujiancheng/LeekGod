@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title LeekGod APK Builder

rem ============================================================
rem  LeekGod - one click release APK build (Windows)
rem
rem  Usage:
rem    double click            -> build release APK into ..\output\
rem    build-apk.bat install   -> build, then adb install -r to device
rem    add --no-pause          -> do not wait for key press (for CI/shell)
rem
rem  Auto detects JDK17 / Android SDK / Gradle 8.x (from the local
rem  gradle dists cache), falling back to JAVA_HOME / ANDROID_HOME
rem  and the usual install paths.
rem  Bump app\build.gradle (versionCode / versionName) before release.
rem
rem  NOTE: keep this file pure ASCII. A .bat with UTF-8 chinese
rem  comments plus "chcp 65001" makes cmd lose line offsets and
rem  execute garbage. Chinese docs belong in README.md.
rem ============================================================

set "PROJ=%~dp0"
set "PROJ=%PROJ:~0,-1%"
for %%i in ("%PROJ%\..") do set "ROOT=%%~fi"

set "DO_INSTALL=0"
set "NOPAUSE=0"
if not "%~1"=="" for %%a in (%*) do (
  if /i "%%~a"=="install" set "DO_INSTALL=1"
  if /i "%%~a"=="--no-pause" set "NOPAUSE=1"
  if /i "%%~a"=="-y" set "NOPAUSE=1"
)

echo ============================================================
echo  LeekGod - build release APK
echo ============================================================
echo  project : %PROJ%
echo.

rem ---------------- 1. locate JDK 17 ----------------
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" goto :java_done
for /d %%d in ("C:\Program Files\Java\jdk-17*") do set "JAVA_HOME=%%~fd"
if defined JAVA_HOME goto :java_done
for /d %%d in ("C:\Program Files\Eclipse Adoptium\jdk-17*") do set "JAVA_HOME=%%~fd"
if defined JAVA_HOME goto :java_done
for /d %%d in ("C:\Program Files\Microsoft\jdk-17*") do set "JAVA_HOME=%%~fd"
if defined JAVA_HOME goto :java_done
if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
:java_done
if not defined JAVA_HOME (
  echo [ERROR] JDK 17 not found.
  echo         Install JDK 17, or set JAVA_HOME to its folder, then run again.
  goto :fail
)
echo  JDK     : %JAVA_HOME%

rem ---------------- 2. locate Android SDK ----------------
set "SDK="
if defined ANDROID_HOME if exist "%ANDROID_HOME%\platforms" set "SDK=%ANDROID_HOME%"
if not defined SDK if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platforms" set "SDK=%ANDROID_SDK_ROOT%"
if not defined SDK if exist "%PROJ%\local.properties" (
  for /f "usebackq tokens=2 delims==" %%a in (`findstr /b /c:"sdk.dir" "%PROJ%\local.properties"`) do (
    set "T=%%a"
    set "T=!T:\:=:!"
    set "T=!T:\\=\!"
    if exist "!T!\platforms" set "SDK=!T!"
  )
)
if not defined SDK if exist "%LOCALAPPDATA%\Android\Sdk\platforms" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined SDK if exist "D:\andriod\platforms" set "SDK=D:\andriod"
if not defined SDK (
  echo [ERROR] Android SDK not found.
  echo         Set ANDROID_HOME, or set sdk.dir in %PROJ%\local.properties
  goto :fail
)
echo  SDK     : %SDK%
set "ANDROID_HOME=%SDK%"

rem ---------------- 3. locate Gradle 8.x ----------------
set "GRADLE="
for /f "delims=" %%f in ('dir /b /s "%USERPROFILE%\.gradle\wrapper\dists\gradle.bat" 2^>nul ^| findstr /i "gradle-8"') do if not defined GRADLE set "GRADLE=%%f"
if not defined GRADLE for %%g in (gradle.bat) do if not defined GRADLE set "GRADLE=%%~$PATH:g"
if not defined GRADLE (
  echo [ERROR] Gradle 8.x not found.
  echo         Open this project once in Android Studio, or put gradle.bat on PATH.
  goto :fail
)
echo  Gradle  : %GRADLE%
echo.

rem ---------------- 4. read version ----------------
set "VER=0.0.0"
set "VC=0"
for /f "tokens=2 delims='" %%v in ('findstr /r /c:"^ *versionName " "%PROJ%\app\build.gradle"') do set "VER=%%v"
for /f "tokens=2" %%c in ('findstr /r /c:"^ *versionCode " "%PROJ%\app\build.gradle"') do set "VC=%%c"
echo  version : %VER% ^(versionCode = %VC%^)
echo.

rem ---------------- 5. build ----------------
pushd "%PROJ%"
call "%GRADLE%" assembleRelease --no-daemon --console=plain
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (
  echo.
  echo [ERROR] Gradle build failed with exit code %RC%, see messages above.
  goto :fail
)

set "SRC=%PROJ%\app\build\outputs\apk\release\app-release.apk"
if not exist "%SRC%" (
  echo [ERROR] APK not produced at %SRC%
  goto :fail
)

rem ---------------- 6. verify signature ----------------
set "SIGNER="
for /f "delims=" %%f in ('dir /b /s "%SDK%\build-tools\apksigner.bat" 2^>nul') do if not defined SIGNER set "SIGNER=%%f"
if not defined SIGNER (
  echo  signing : skipped ^(apksigner not found in build-tools^)
) else (
  call "%SIGNER%" verify --print-certs "%SRC%" >nul 2>&1
  if errorlevel 1 (
    echo [WARN] signature check FAILED - APK looks unsigned, players cannot install it.
  ) else (
    echo  signing : OK
  )
)

rem ---------------- 7. publish to output ----------------
if not exist "%ROOT%\output" mkdir "%ROOT%\output"
set "DEST=%ROOT%\output\LeekGod-v%VER%.apk"
copy /y "%SRC%" "%DEST%" >nul
if errorlevel 1 (
  echo [ERROR] Copy to %DEST% failed.
  goto :fail
)

echo.
echo ============================================================
echo  DONE  -^>  %DEST%
for %%s in ("%DEST%") do echo  size  : %%~zs bytes
echo ============================================================

rem ---------------- 8. optional install ----------------
if "%DO_INSTALL%"=="1" (
  set "ADB=%SDK%\platform-tools\adb.exe"
  if not exist "!ADB!" set "ADB=adb"
  echo.
  echo Installing to connected device...
  call "!ADB!" install -r "%DEST%"
  if errorlevel 1 (
    echo [WARN] adb install failed - check USB debugging / cable.
  ) else (
    echo  installed.
  )
)

echo.
call :finish "Build finished."
exit /b 0

:fail
call :finish "Build aborted."
exit /b 1

:finish
echo %~1
if "%NOPAUSE%"=="1" exit /b 0
echo Press any key to close...
pause >nul
exit /b 0
