@echo off
echo ====================================================
echo Google Chrome - Pi Agent Remote Debugging Launcher
echo ====================================================
echo.
echo Launching Chrome with remote debugging on port 19222...
echo.

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=19222 --user-data-dir="%USERPROFILE%\.pi\agent\ai-consult-profile"

echo.
echo Chrome has been started on port 19222!
echo You can now use Pi Agent with your logged-in Claude, ChatGPT, and Gemini accounts.
echo.
pause
