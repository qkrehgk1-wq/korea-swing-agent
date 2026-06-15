import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { getLoginUrl, hasOAuthConfig } from "@/const";

export default function Home() {
  const { user, isAuthenticated } = useAuth();
  const loginUrl = getLoginUrl();
  const oauthEnabled = hasOAuthConfig();

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b bg-white sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="text-2xl font-bold text-blue-600">📈 한국 스윙 분석 에이전트</div>
          </div>
          <div>
            {isAuthenticated ? (
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground">{user?.name}</span>
                <Button variant="outline" size="sm" onClick={() => (window.location.href = `/dashboard/analysis`)}>
                  대시보드
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => (window.location.href = oauthEnabled ? `${loginUrl}&returnPath=/dashboard/analysis` : "/dashboard/analysis")}>
                {oauthEnabled ? "로그인" : "로컬로 시작"}
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1">
        <section className="bg-gradient-to-b from-blue-50 to-white py-20">
          <div className="max-w-4xl mx-auto px-4 text-center">
            <h1 className="text-5xl font-bold mb-6 text-gray-900">
              한국 주식 스윙 매매를 위한 AI 에이전트
            </h1>
            <p className="text-xl text-gray-600 mb-8">
              차트, 거래량, 이동평균, 패턴, 수급, 공식 재무(DART)를 근거로
              <br />
              5개 역할 AI 에이전트가 실전 스윙 타점을 분석합니다.
            </p>
            <Button
              size="lg"
              className="gap-2"
              onClick={() => (window.location.href = oauthEnabled ? `${loginUrl}&returnPath=/dashboard/analysis` : "/dashboard/analysis")}
            >
              <Loader2 className="h-5 w-5" />
              {oauthEnabled ? "지금 시작하기" : "로컬 개발 모드 시작"}
            </Button>
          </div>
        </section>

        {/* Features Section */}
        <section className="py-16 bg-white">
          <div className="max-w-6xl mx-auto px-4">
            <h2 className="text-3xl font-bold mb-12 text-center">주요 기능</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {[
                {
                  title: "한국 시세·재무 통합",
                  description: "pykrx·DART·KRX 기반 OHLCV, 공식 재무, 수급 데이터를 한 번에 조회",
                },
                {
                  title: "5개 역할 AI 에이전트",
                  description: "패턴, 지표, 수급, 리스크, 스윙 전략의 5가지 관점에서 LLM이 분석",
                },
                {
                  title: "스윙 매매 프레임워크",
                  description: "차트 구조, 거래량, 이동평균, 패턴 완성도로 스윙 적합도를 평가",
                },
                {
                  title: "기술적 스윙 스캐너",
                  description: "밥그릇·하이힐·돌파·컵앤핸들 패턴으로 오늘의 후보를 자동 발굴",
                },
                {
                  title: "매일 자동 추천 알림",
                  description: "백테스트·튜닝을 거친 스윙·상한가 후보를 매일 텔레그램으로 전송",
                },
                {
                  title: "관심종목 변동 감지",
                  description: "급등·급락, 거래량 급증, 신고가 근접을 감지해 중복 없이 알림",
                },
              ].map((feature, idx) => (
                <div key={idx} className="p-6 border rounded-lg hover:shadow-lg transition-shadow">
                  <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                  <p className="text-gray-600">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-16 bg-blue-600 text-white">
          <div className="max-w-4xl mx-auto px-4 text-center">
            <h2 className="text-3xl font-bold mb-6">지금 바로 시작하세요</h2>
            <p className="text-lg mb-8 opacity-90">
              5개 역할 AI 에이전트와 함께
              <br />
              한국 주식의 스윙 타점을 발견하세요.
            </p>
            <Button
              size="lg"
              variant="secondary"
              onClick={() => (window.location.href = oauthEnabled ? `${loginUrl}&returnPath=/dashboard/analysis` : "/dashboard/analysis")}
            >
              대시보드 접속
            </Button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t bg-gray-50 py-8">
        <div className="max-w-7xl mx-auto px-4 text-center text-sm text-gray-600">
          <p>한국 스윙 분석 에이전트 • Powered by Manus AI</p>
        </div>
      </footer>
    </div>
  );
}
