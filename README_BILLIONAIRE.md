# 한국 주식 스윙 분석 에이전트

> 차트·거래량·이동평균·패턴·수급·공식 재무(DART)를 근거로, 5개 역할의 LLM 에이전트가 한국 주식의 단기~중기(2~8주) 스윙 타점을 분석하는 시스템입니다. 미국 주식 기능은 제거되었고, 한국 시장 전용으로 재설계되었습니다.

---

## 핵심 특징

### 1. LLM 멀티에이전트 분석 (Claude Opus 4.8)
종목 코드(예: `005930`)를 입력하면 실데이터로 **사실 시트(fact sheet)** 를 만들어 5개 역할 에이전트가 해석합니다.

| 탭 | 역할 | 관점 |
|----|------|------|
| 패턴 | 패턴 구조 분석가 | 밥그릇/하이힐/돌파/컵앤핸들 등 차트 구조 |
| 지표 | 기술적 지표 분석가 | 이동평균·거래량·모멘텀·변동성 |
| 거래량 | 수급 분석가 | 외국인·기관 수급, 거래량 |
| 리스크 | 리스크 관리자 | 변동성·낙폭·추세 훼손 조건 |
| 스윙메모 | 스윙 전략가 | 시장 위치·실전 해석 |

- **진짜 Claude 직접 호출**: `ANTHROPIC_API_KEY`가 있으면 공식 `@anthropic-ai/sdk`로 `claude-opus-4-8`(adaptive thinking)을 직접 호출합니다. 없으면 Forge 게이트웨이로 폴백합니다.
- **결정론적 폴백**: LLM이 실패/지연/미설정이면 규칙 기반 분석으로 자동 대체 — 출력이 규칙 기반보다 나빠지지 않습니다.

### 2. Signal Council — 7차원 점수 시스템
모든 종목을 7개 차원으로 평가하고 **ACT / PREPARE / WATCH / AVOID** 결정을 내립니다.

| 차원 | 의미 |
|------|------|
| 추세 강도 | 이평 정렬·수익률 |
| 거래량 신뢰 | 20일 평균 대비 배수 |
| 패턴 완성도 | 감지된 스윙 패턴 |
| 진입 타점 | 눌림목/돌파/과열 회피 |
| 수급 | 외국인·기관 또는 거래량 프록시 |
| 리스크 | 변동성·낙폭 (높을수록 위험) |
| 펀더멘털 | DART 공식 재무 뒷받침 |

가중 총점(0~100)이 대시보드의 "스윙 적합 점수"가 됩니다. (결정론적 — LLM 무관)

### 3. 데이터 검증 하네스 (DataValidator)
LLM이 쓴 모든 분석은 발행 전 "헌법 검증"을 통과해야 합니다.
- **스캠/원금보장 류 표현** → 차단하고 결정론 텍스트로 대체
- **과장·공포 마케팅 톤**("무조건", "절대 놓치지 마") → 로그(`​.data/logs/constitution-violations.jsonl`)

### 4. 지휘관 전용 채널 (Commander Eyes Only)
정제된 추천은 일반 텔레그램 채널로, **고확신(ACT·85점↑)/고위험(리스크 9↑) 신호는 날것 그대로** `COMMANDER_CHAT_ID`로 별도 전송하고 `secure_zone/commander_eyes_only.md`에 기록합니다.

### 5. 기술적 스윙 스캐너 + 적응형 학습
밥그릇·하이힐·돌파·컵앤핸들 패턴으로 한국 종목군을 스캔하고, 백테스트→튜닝→학습 가중치 갱신 루프로 스스로 품질 필터를 조정합니다.

### 6. 관심종목 변동 감지 + 뉴스
- 관심종목의 급등락·거래량 급증·신고가 근접을 감지(이전 거래일과 비교해 중복 없이 알림).
- `SERPER`/`TAVILY`/`NEWS_API` 키가 있으면 종목 뉴스를 수집해 분석에 반영합니다.

### 7. 알파 리서치 에이전트
웹 전반에서 최신 스윙·모멘텀·리스크·AI퀀트 기법을 검색하고, Claude가 **우리 한국 일봉 스윙 시스템에 적용 가능한 형태**(논리·예상 효과·적용 방법·주의점·우선순위)로 증류합니다. 검색/LLM이 없으면 검증된 큐레이션 기법으로 대체합니다.
- 실행: `corepack pnpm start:swing:alpha` (리포트 저장 + 지휘관 채널 요약 발송)
- 발견 기법은 바로 매수 규칙에 넣지 않고 **백테스트 후보·규칙 보조축**으로만 제안합니다.

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | React 19 · Vite · tRPC · TanStack Query · shadcn/ui · Wouter |
| 백엔드 | Express · tRPC · Drizzle ORM(MySQL/TiDB) · helmet · rate-limit |
| LLM | Claude Opus 4.8 (공식 Anthropic SDK 직접 호출, Forge 폴백) |
| 데이터 | pykrx · OPEN DART · KRX MCP (`.mcp.json`) |
| 알림 | 텔레그램(일반/지휘관) · 카카오 · Manus 오너 알림 |
| 자동화 | GitHub Actions (일일 스케줄) |

---

## 분석 파이프라인

```
종목코드 입력 (6자리)
        │
        ▼
[데이터 수집]  pykrx OHLCV + DART 재무 + KRX 수급
        │
        ▼
[Signal Council]  7차원 점수 → ACT/PREPARE/WATCH/AVOID (결정론)
        │
        ▼
[뉴스 수집]  Serper/Tavily/NewsAPI (선택)
        │
        ▼
[5개 LLM 에이전트]  사실 시트 기반 해석 (Claude Opus 4.8)
        │
   [DataValidator 하네스]  스캠 차단 · 톤 위반 로깅
        │
        ▼
[종합 투자 메모]  + 지휘관 채널 분기(고확신/고위험)
```

---

## 설치 및 실행

```bash
corepack pnpm install
corepack pnpm dev          # 개발 서버
corepack pnpm build        # 프로덕션 빌드
corepack pnpm start        # 프로덕션 실행
corepack pnpm start:monitor # 관심종목 모니터링 잡
corepack pnpm start:swing  # 스윙 추천 텔레그램 발송
```

- 개발 모드에선 DB가 없어도 `.data/local-store.json`으로 분석 이력/관심종목이 저장됩니다.
- 한국 종목은 `pykrx-mcp`로 가격 기반 분석을, `DART_API_KEY`/`KRX_API_KEY`가 있으면 공식 재무/거래 데이터까지 함께 사용합니다.

---

## 환경 변수

`.env.local`(우선) → `.env` 순으로 로드됩니다. (`.env.example` 참고)

**LLM (택1)**
- `ANTHROPIC_API_KEY` — **권장**. 공식 Claude 직접 호출.
- `ANTHROPIC_MODEL` — 기본 `claude-opus-4-8`.
- `LLM_EFFORT` — `low|medium|high|max` (기본 `high`).
- `BUILT_IN_FORGE_API_KEY` / `FORGE_MODEL` — Anthropic 키가 없을 때의 폴백.

**데이터**
- `DART_API_KEY` · `KRX_API_KEY` — 한국 공식 재무/거래 보강.
- `KOREAN_STOCK_MCP_ENABLED` — `false`면 한국 MCP 비활성.

**알림**
- `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID` — 일반 추천 채널.
- `COMMANDER_CHAT_ID` — 지휘관 전용 날것 신호 채널.
- `KAKAO_*` — 카카오톡 나와의 채팅 발송(선택).

**뉴스/검색(선택)**
- `SERPER_API_KEY` · `TAVILY_API_KEY` · `NEWS_API_KEY`

**보안/운영(선택)**
- `RATE_LIMIT_MAX` — 분당 API 요청 한도(기본 120).
- `COOKIE_SAMESITE` — 기본 `lax`. cross-site iframe 임베드 시에만 `none`.

---

## 자동화 (GitHub Actions)

| 워크플로 | 시각(KST) | 동작 |
|----------|-----------|------|
| Daily Swing Recommendations | 03:40 | 백테스트 → 튜닝 → 스윙/상한가 추천 텔레그램 발송 |
| Daily Market Monitor | 04:20 | 관심종목 변동 감지 + 일일 요약 + 스윙 스캔 |

시크릿(`ANTHROPIC_API_KEY`, `TELEGRAM_*`, `COMMANDER_CHAT_ID`, `DART_API_KEY`, `KRX_API_KEY`, `DATABASE_URL` 등)은 GitHub repository secrets에 등록되어야 합니다.

---

## 보안

- OAuth 기반 인증 + tRPC 타입 안전 API.
- 분석 조회는 **소유권 검증**(타인의 분석 열람 차단).
- `helmet` 보안 헤더 + `express-rate-limit`(분석은 LLM 다중 호출이라 보호).
- 쿠키 `sameSite: lax`(CSRF 완화).
- 시크릿은 `.env.local`/repository secrets로만 관리(`.gitignore` 처리).

---

## 테스트

```bash
corepack pnpm test    # vitest
corepack pnpm check   # tsc --noEmit
```

---

**아키텍처 참고:** 다중 에이전트 협업·데이터 검증 하네스·지휘관 채널·7차원 점수 구조는 `바탕화면/미래/avatar_core`의 Signal Council 설계를 한국 스윙 매매 맥락으로 이식한 것입니다.

**버전:** 2.0.0 (한국 스윙 전용 + Signal Council)
