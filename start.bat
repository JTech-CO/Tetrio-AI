@echo off
REM ── TETR.IO ZEN 자동 플레이 봇 ──────────────────────────────────
REM 앱을 디버그 포트 + 스로틀링 해제 플래그로 (재)시작하고, 광고를 차단한 뒤
REM ZEN 화면을 감지하면 자동으로 플레이합니다.
REM
REM 사용법:  start.bat                (무한 플레이, 기존 앱 재사용)
REM          start.bat --mode rapid   (RAPID 모드로 바로 시작)
REM          start.bat --restart      (앱을 새로 시작)
REM          start.bat --pieces 500
REM
REM ZEN 화면이 감지되면 이 콘솔에 모드 메뉴가 표시됩니다.
REM 플레이 중에도 1|basic, 2|rapid + Enter 로 즉시 전환할 수 있습니다.
REM ────────────────────────────────────────────────────────────────
cd /d "%~dp0"
node src\run.js %*
pause
