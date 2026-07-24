@echo off
setlocal
set "ROOT=%~dp0"
node "%ROOT%dist\src\cli\main.js" %*
