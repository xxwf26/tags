@echo off
REM 开机/登录自启 style-atlas（pm2）。仅启动 style-atlas，不影响其他 pm2 应用。
cd /d C:\Users\xxwf\IdeaProjects\tags\server
"D:\support\nodejs\node_global\pm2.cmd" start style-atlas 2>nul
if errorlevel 1 "D:\support\nodejs\node_global\pm2.cmd" start ecosystem.config.cjs
