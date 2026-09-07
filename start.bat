@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Запуск сервера сайта и GigaChat
cd /d "%~dp0"

echo =============================================
echo   Sber Finance Scanner — запуск
echo   Сайт:      http://localhost:3000
echo   GigaChat:  http://localhost:8000  (POST /chat)
echo =============================================
echo.

REM ---- 1) Подготовка .env для GigaChat ----
REM gigachat_ai.py читает ключи из .env, а сами ключи лежат в gigachat.env
if not exist ".env" (
    if exist "gigachat.env" (
        copy /y "gigachat.env" ".env" >nul
        echo [OK] Создан .env из gigachat.env с ключами GigaChat
    ) else (
        echo [ВНИМАНИЕ] gigachat.env не найден. GigaChat запустится без ключей.
    )
)

REM ---- 2) Поиск Python (в т.ч. Microsoft Store / WindowsApps) ----
set "PYEXE="
where python.exe >nul 2>nul
if not errorlevel 1 set "PYEXE=python.exe"
if not defined PYEXE (
    where py >nul 2>nul
    if not errorlevel 1 set "PYEXE=py -3"
)
REM WindowsApps app-execution alias (Python из Microsoft Store)
if not defined PYEXE (
    if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe" set "PYEXE=%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe"
)
if not defined PYEXE (
    if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe" set "PYEXE=%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe"
)

if not defined PYEXE (
    echo.
    echo [ОШИБКА] Python не найден.
    echo Установите Python, затем выполните:  python -m venv venv
    pause
    exit /b 1
)
echo [GigaChat] Использую Python: %PYEXE%

REM ---- 3) Создание виртуального окружения при необходимости ----
set "PY=venv\Scripts\python.exe"
if not exist "%PY%" (
    echo [GigaChat] venv не найден, создаю виртуальное окружение...
    %PYEXE% -m venv venv
    if not exist "%PY%" (
        echo.
        echo [ОШИБКА] Не удалось создать venv. Python может быть только Microsoft Store alias.
        echo Установите Python из python.org и повторите.
        pause
        exit /b 1
    )
)

REM ---- 4) Установка Python-зависимостей GigaChat (при необходимости) ----
"%PY%" -m pip show uvicorn >nul 2>nul
if errorlevel 1 (
    echo [GigaChat] Устанавливаю Python-зависимости...
    "%PY%" -m pip install --upgrade pip >nul
    "%PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [ОШИБКА] Не удалось установить Python-зависимости.
        pause
        exit /b 1
    )
)

REM ---- 5) Запуск GigaChat в отдельном окне (порт 8000) ----
start "GigaChat Server (8000)" cmd /k "venv\Scripts\python.exe -m uvicorn gigachat_ai:app --host 0.0.0.0 --port 8000"
timeout /t 2 /nobreak >nul

REM ---- 6) NPM-зависимости ----
where npm.cmd >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] npm не найден. Установите Node.js.
    pause
    exit /b 1
)
call npm.cmd install

REM ---- 7) Запуск сайта в отдельном окне (порт 3000) ----
start "Sber Finance Scanner (3000)" cmd /k "npm.cmd start"
timeout /t 2 /nobreak >nul

REM ---- 8) Открываем сайт в браузере ----
start "" "http://localhost:3000"

echo.
echo =============================================
echo Успешно запущены:
echo   Сайт:      http://localhost:3000
echo   GigaChat:  http://localhost:8000  (POST /chat)
echo =============================================
echo.
echo Закройте отдельные окна серверов, чтобы остановить их.
echo.
pause
endlocal