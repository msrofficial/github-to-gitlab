@echo off
rem Wrapper for Windows Task Scheduler: runs the mirror from this folder.
cd /d "%~dp0"
node --env-file=.env mirror.mjs >> mirror.log 2>&1
exit /b %ERRORLEVEL%
