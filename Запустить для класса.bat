@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю «Знание в коробке» для всего класса...
where python >nul 2>nul || (echo Нужен Python 3.10+: https://www.python.org/downloads/ & pause & exit /b 1)
where ollama >nul 2>nul && (start "" /min ollama serve >nul 2>nul)
echo.
echo 1. Включите раздачу сети: Параметры - Сеть и Интернет - Мобильный хот-спот.
echo 2. Если Windows спросит про доступ Python к сети - нажмите «Разрешить».
echo 3. На открывшейся странице будет QR-код для телефонов учеников.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8000/#/connect"
python server\server.py --box
pause
