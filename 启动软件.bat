@echo off
chcp 65001 >nul
title Psy剪贴板 - 开发运行窗口(退出软件后可关闭)
cd /d "%~dp0"
echo.
echo   正在启动 Psy剪贴板,请稍候几秒...
echo   启动后请到任务栏右下角找蓝色剪贴板图标(可能藏在 ^ 上箭头里)
echo   提示:本窗口可以最小化,但不要关闭;想退出软件请右键托盘图标选"退出"
echo.
npm start
