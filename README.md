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
속도와 라인 클리어 방식은 콘솔에 `[속도]-[방식]` + Enter로 함께 고릅니다. 시작 메뉴에서도, 플레이 중에도 같은 명령입니다.

| 명령 | 속도 | 방식 |
|---|---|---|
| `1-s` / `1-q` | BASIC | SINGLE / QUAD |
| `2-s` / `2-q` | RAPID | SINGLE / QUAD |
| `3-s` / `3-q` | TURBO | SINGLE / QUAD |

`rapid-quad`처럼 이름으로 써도 됩니다. 방식은 다음 배치부터, 속도는 피스 경계에서 바뀝니다. `status`로 통계를 확인하고, 종료는 `Ctrl+C`입니다.

## 속도(모드)

| 속도 | 동작 |
|---|---|
| BASIC | 매 피스 화면을 읽는 기본 모드 |
| RAPID | 화면 읽기·다음 수 계산을 스폰 대기와 병렬 수행 |
| TURBO | 보정된 입력과 최대 2피스 예측 실행, 비동기 화면 검증 |

**최종 TURBO 실측: 500피스 / 93.940초 = 5.323 PPS**(합격 판정 스크립트 기준). 의심 피스·재동기화·입력 오류·폴백 모두 0회였습니다.
이후 1,000피스도 폴백·오배치 없이 완주했습니다(최고 실효 5.71 PPS, `run.js` 측정). 레벨 전환이 포함된 장기 실행은 아직 검증되지 않았습니다.

## 라인 클리어 방식

모드(속도)와 별개로, 모든 모드에서 두 방식 중 하나로 플레이합니다. 시작 시 `--strategy`로 정하고, 플레이 중에는 위의 `[속도]-[방식]` 명령으로 바꿉니다(다음 배치부터 적용).

| 방식 | 플레이 |
|---|---|
| SINGLE (기본) | 줄이 차는 대로 바로 지웁니다(Dellacherie). 대부분 1줄 클리어 |
| QUAD | 오른쪽 끝 열을 비워 두고 나머지 9열을 구멍 없이 쌓은 뒤, 세운 I 미노로 4줄을 한 번에 지웁니다. I가 일찍 오면 홀드에 보관합니다. 스택이 10줄 이상이면 SINGLE로 줄을 낮춘 뒤 다시 쌓습니다 |

오프라인 시뮬레이션(`node probe/quad_sim.js`, 7-bag·NEXT 5개·홀드, 18,000피스)에서 QUAD는 지운 줄의 약 94%를 쿼드로 지웠고, 피스당 점수(가이드라인 100/300/500/800, 연속 쿼드 ×1.5)는 SINGLE의 약 2.5배였습니다. 탑아웃은 두 방식 모두 0회였습니다. 대신 스택이 평균 5.4줄로 SINGLE(2.8줄)보다 높고, 12줄에 닿는 피스가 약 0.1% 있어 그때는 TURBO가 잠시 RAPID로 넘겼다가 돌아옵니다.

실게임 1,300피스(2026-09-25, 1278×1002, [로그](docs/quad-run-1300-2026-09-25.txt))에서는 콘솔 입력만으로 RAPID·SINGLE → RAPID·QUAD → BASIC·QUAD → TURBO·QUAD 순으로 바꿔 가며 플레이했습니다. QUAD 전환 이후 지운 454줄 중 432줄(95%)이 쿼드 108회였고, 오배치는 0회였습니다. TURBO·QUAD의 실효 속도는 6.07~6.25 PPS로 SINGLE(최고 5.71)보다 빨랐는데, 줄 삭제 뒤마다 화면을 다시 확인하는 대기가 쿼드에서는 네 줄에 한 번만 생기기 때문입니다. 레벨 전환 1회는 RAPID로 넘겼다가 스택 4줄에서 TURBO로 복귀했습니다. 같은 전환 순서는 `node probe/console_drive.js <로그> 150:2-q 500:1-q 650:3-q -- --mode rapid --pieces 1300 --restart-every 0`로 재현합니다.

## TURBO 실행·검증

```bash
node src/run.js --mode turbo --pieces 500
```

- 입력 보정은 창 크기마다 따로 저장되며(`probe/turbo-calibration-<w>x<h>@<dpr>.json`), 처음 보는 크기에서는 TURBO가 시작할 때 자동으로 보정합니다(2~4분). 보정 중에는 TETR.IO 창을 가리지 마세요 — 창이 가려지면 게임이 멈춰 보정할 수 없습니다.
- 최대화 창은 화면 갱신이 느려 보정에 실패할 수 있습니다. 실패한 크기는 기록되어 이후 바로 RAPID로 진행하므로, TURBO는 창 모드로 실행하세요.
- 키 설정·DAS/ARR·게임 버전이 바뀌면 `npm run turbo:calibrate`로 다시 재거나 보정 파일을 지워 자동 보정이 다시 돌게 하세요. 보정 파일은 머신별이며 Git에 포함하지 않습니다.
- 공식 합격 판정은 `node probe/validate_turbo.js 500 --turbo-only --warmup`이며, 현재 창 크기로 보정된 상태여야 합니다(결과: `probe/turbo-validation-500.json`). 수동 보정과 합격 판정 스크립트는 메뉴를 조작하지 않으므로 앱이 ZEN 화면에 있을 때 실행합니다.
- 모든 모드에서 화면 흔들림·바운스·액션 텍스트를 잠시 끄고, 종료·오류 시 원래 설정으로 복원합니다.
- 지속 불일치나 지연은 재동기화 또는 RAPID 폴백으로 처리합니다. Jev는 사용하지 않습니다.
- 프로브 포트는 `TETRIO_PORT`로 지정합니다(기본 9222).

## 실행 옵션

| 옵션 | 기본값 | 용도 |
|---|---|---|
| `--mode basic/rapid/turbo` | basic | 시작 모드 |
| `--strategy single/quad` (`s`/`q`) | single | 라인 클리어 방식 |
| `--pieces N` | 무제한 | 배치 수 제한 |
| `--port P` | 9222 | CDP 포트 |
| `--calibration FILE` | 창 크기별 자동 선택 | 지정한 TURBO 보정 파일만 사용(자동 보정 안 함) |
| `--restart` | 꺼짐 | 앱 재시작 |
| `--restart-every N` / `--restart-mins M` | 2500 / 20 | 먼저 도달한 조건에서 재시작, 0은 해당 조건 해제 |
| `--quality Q` | 85 | JPEG 품질(1–100) |
| `--postdrop N` | 모드별 | BASIC/RAPID 드롭 후 대기(ms, 최소 90); TURBO 보정 시간에는 미적용 |
| `--no-adblock` | 꺼짐 | 광고 차단 비활성화 |

## 개발·문서

`npm test`로 회귀 테스트를 실행합니다. 보드·AI는 `src/board.js`와 `src/ai.js`, 일반 루프는 `src/bot.js`, 예측 실행은 `src/turbo.js`에 있습니다.

- [TURBO 구현·검증 요약](docs/TURBO-RESULTS-KR.md)
- [일반 모드·공통 런타임 수정](docs/LEGACY-DEBUG-KR.md)
