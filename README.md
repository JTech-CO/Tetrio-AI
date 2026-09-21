# TETR.IO ZEN 자동 플레이 봇

Windows용 TETR.IO 데스크톱 앱에 CDP로 연결해 화면 픽셀을 읽고, 로컬 AI로 배치를 계산해 키를 입력합니다. ZEN 연구·실험용입니다.

## 시작

Node.js 18 이상(검증: 25.9.0)과 TETR.IO 데스크톱 앱이 필요합니다.
기본 앱 경로는 `%LOCALAPPDATA%\Programs\tetrio-desktop\TETR.IO.exe`입니다.

```bash
npm install
npm start                              # BASIC, 기존 앱 재사용
node src/run.js --mode rapid --pieces 500
```

Windows에서는 `start.bat`도 사용할 수 있습니다. 디버그 포트 없이 실행된 앱은 연결을 위해 재시작합니다.
ZEN 자동 진입이 실패하면 앱에서 Solo → ZEN으로 들어가세요.
콘솔에서 `1/basic`, `2/rapid`, `3/turbo`로 피스 경계에 모드를 전환하고, `status`로 통계를 확인합니다. 종료는 `Ctrl+C`입니다.

## 모드

| 모드 | 방식 |
|---|---|
| BASIC | 매 피스 화면을 읽는 기본 모드 |
| RAPID | 화면 읽기·다음 수 계산을 스폰 대기와 병렬 수행 |
| TURBO | 보정된 입력과 최대 2피스 예측 실행, 비동기 화면 검증 |

**최종 TURBO 실측: 500피스 / 93.940초 = 5.323 PPS.** 의심 피스·재동기화·입력 오류·폴백 모두 0회였습니다.
최종 코드의 1,000피스 완주는 미검증이며, 장기 실행에서 간헐적 캡처 지연 폴백이 관측됐습니다.

## TURBO 실행·검증

먼저 `npm start`로 디버그 포트를 열고 ZEN에 진입한 뒤 봇을 종료합니다. 앱은 열어 둔 채 다음을 실행하세요.

```bash
npm run turbo:calibrate -- 120
node src/run.js --mode turbo --pieces 500
node probe/validate_turbo.js 500 --turbo-only --warmup
```

- 키 설정·DAS/ARR·게임 버전·창 크기가 바뀌면 다시 보정하세요. 보정 파일은 머신별로 생성하며 Git에 포함하지 않습니다.
- TURBO는 화면 흔들림·바운스·액션 텍스트를 잠시 끄고 종료·오류·모드 전환 시 복원합니다.
- 지속 불일치나 지연은 재동기화 또는 RAPID 폴백으로 처리합니다. Jev는 사용하지 않습니다.
- 프로브 포트는 `TETRIO_PORT`로 지정합니다(기본 9222). 결과는 `probe/turbo-validation-500.json` 등에 저장됩니다.

## 실행 옵션

| 옵션 | 기본값 | 용도 |
|---|---|---|
| `--mode basic/rapid/turbo` | basic | 시작 모드 |
| `--pieces N` | 무제한 | 배치 수 제한 |
| `--port P` | 9222 | CDP 포트 |
| `--calibration FILE` | probe/turbo-calibration.json | TURBO 보정 파일 |
| `--restart` | 꺼짐 | 앱 재시작 |
| `--restart-every N` / `--restart-mins M` | 2500 / 20 | 먼저 도달한 조건에서 재시작, 0은 해당 조건 해제 |
| `--quality Q` | 85 | JPEG 품질(1–100) |
| `--postdrop N` | 모드별 | BASIC/RAPID 드롭 후 대기(ms, 최소 90); TURBO 보정 시간에는 미적용 |
| `--no-adblock` | 꺼짐 | 광고 차단 비활성화 |

## 개발·문서

`npm test`로 회귀 테스트를 실행합니다. 보드·AI는 `src/board.js`와 `src/ai.js`, 일반 루프는 `src/bot.js`, 예측 실행은 `src/turbo.js`에 있습니다.

- [TURBO 구현·검증 요약](docs/TURBO-RESULTS-KR.md)
- [일반 모드·공통 런타임 수정](docs/LEGACY-DEBUG-KR.md)
- [TURBO 설계 백서](Tetrio-AI-TURBO-Design-KR-v0.1.0.md)
