@echo off
cls
echo ==============================================
echo Запуск сервера Sber Finance Scanner...
echo ==============================================

REM Проверяем существование папки virtual environment
IF NOT EXIST "venv\" (
    echo [ОШИБКА] Папка 'venv\' не найдена.
    echo Пожалуйста, создайте виртуальное окружение командой: python -m venv venv
    pause
    exit /b
)

REM Активация виртуального окружения
call venv\Scripts\activate.bat

REM Установка зависимостей, если они отсутствуют
where npm >nul 2>nul
if %errorlevel% neq 0 (
    echo [ОШИБКА] NPM не обнаружен. Убедитесь, что Node.js установлен.
    pause
    exit /b
)

npm install

REM Запуск сервера
npm start

pause