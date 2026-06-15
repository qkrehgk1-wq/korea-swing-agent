# 한국 스윙 분석 에이전트 — 작업 현황

## 완료 (v2.0 — 한국 전용 + Signal Council)

- [x] 미국 주식(Yahoo) 코드·데이터 완전 제거
- [x] 한국 LLM 멀티에이전트 분석 엔진 (5개 역할, 결정론 폴백)
- [x] Claude Opus 4.8 직접 호출 (공식 Anthropic SDK, Forge 폴백)
- [x] Signal Council 7차원 점수 + ACT/PREPARE/WATCH/AVOID 결정
- [x] DataValidator 하네스 (스캠 차단·과장 톤 위반 로깅)
- [x] 지휘관 전용 채널 (고확신/고위험 날것 신호 분기)
- [x] 뉴스/시장심리 에이전트 (Serper / Tavily / NewsAPI)
- [x] 관심종목 변동 감지 (이전 거래일 diff로 중복 알림 제거)
- [x] 보안 하드닝 (helmet · rate-limit · 쿠키 lax · 분석 소유권 검증)
- [x] LLM 인프라 (타임아웃 · 재시도 · 모델 폴백)
- [x] 문서 재작성 (README) + 전체 검증 (tsc · vitest · build)
- [x] 알파 리서치 에이전트 (웹 검색 + Claude 증류 → 시스템 적용안, `start:swing:alpha`)

## 향후 개선 후보

- [ ] 클라이언트에 Signal Council 7차원 시각화 (레이더 차트)
- [ ] 지휘관 채널 알림 쿨다운 (동일 종목 반복 알림 억제)
- [ ] 네이버 공식 검색 API 연동으로 한국 뉴스 정확도 향상
- [ ] 자기 진화 루프 확장 (백테스트 지표 기반 가중치 자동 채택)
- [ ] DART 재무 다년치 추세 분석
- [ ] 포트폴리오 단위 리스크 합산

## 명명 규칙

- 점수 시스템: "Signal Council 7차원 점수"
- 결정 신호: ACT(실행) / PREPARE(준비) / WATCH(관찰) / AVOID(회피)
- 분석 점수: "스윙 적합 점수" (0~100, Signal Council 가중 총점)
- 알림 대상: 일반 채널(정제 추천) / 지휘관 채널(날것 신호)
