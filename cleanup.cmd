@echo off
node "%~dp0scripts\cleanup.mjs" %*
exit /b %errorlevel%
