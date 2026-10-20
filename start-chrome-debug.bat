@echo off
echo ====================================================
echo Google Chrome - Pi Agent Remote Debugging Launcher
echo ====================================================
echo.
echo Closing any lingering Chrome background tasks if needed...
echo Launching Chrome with remote debugging on port 9222...
echo.

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222

echo.
echo Chrome has been started on port 9222!
echo You can now use Pi Agent with your logged-in Claude and ChatGPT accounts.
echo.
pause
