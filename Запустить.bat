@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запускаю «Знание в коробке»...
where python >nul 2>nul || (echo Нужен Python 3.10+: https://www.python.org/downloads/ & pause & exit /b 1)
where ollama >nul 2>nul && (start "" /min ollama serve >nul 2>nul)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8000"
python server\server.py
pause
