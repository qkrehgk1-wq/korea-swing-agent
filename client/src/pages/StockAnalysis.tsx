import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, TrendingUp, AlertCircle, CheckCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Streamdown } from "streamdown";
import { toast } from "sonner";

const PENDING_TICKER_KEY = "pending-analysis-ticker";

export default function StockAnalysis() {
  const [ticker, setTicker] = useState("");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  const analyzeMutation = trpc.stocks.analyze.useMutation();
  const swingScreenerQuery = trpc.stocks.screenSwing.useQuery(undefined, {
    enabled: false,
    refetchOnWindowFocus: false,
  });
  const historyQuery = trpc.stocks.getHistory.useQuery();
  const watchlistMutation = trpc.watchlist.add.useMutation();

  const runAnalysis = async (tickerValue: string) => {
    setIsAnalyzing(true);
    setSelectedTicker(tickerValue.toUpperCase());

    try {
      await analyzeMutation.mutateAsync({
        ticker: tickerValue.toUpperCase(),
      });
      historyQuery.refetch();
    } catch (error) {
      console.error("Analysis error:", error);
      toast.error("분석에 실패했습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setIsAnalyzing(false);
      setTicker("");
    }
  };

  const handleAnalyze = async () => {
    if (!ticker.trim()) return;
    await runAnalysis(ticker.trim());
  };

  useEffect(() => {
    const pendingTicker = sessionStorage.getItem(PENDING_TICKER_KEY);
    if (pendingTicker) {
      sessionStorage.removeItem(PENDING_TICKER_KEY);
      setTicker(pendingTicker);
      void runAnalysis(pendingTicker);
    }
  }, []);

  const handleAddToWatchlist = async () => {
    if (!selectedTicker) return;
    try {
      await watchlistMutation.mutateAsync({ ticker: selectedTicker });
      toast.success(`${selectedTicker}를 관심종목에 추가했습니다.`);
    } catch (error) {
      console.error("Watchlist error:", error);
      toast.error("관심종목 추가에 실패했습니다.");
    }
  };

  const currentAnalysis = analyzeMutation.data;
  const isLoading = analyzeMutation.isPending || isAnalyzing;
  const framework = currentAnalysis?.framework;
  const swingCandidates = swingScreenerQuery.data?.candidates ?? [];
  const swingBible = swingScreenerQuery.data?.bible ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>기술적 스윙 스캐너</CardTitle>
          <CardDescription>
            밥그릇, 하이힐, 돌파, 컵앤핸들 관점으로 한국 종목군을 스캔해 스윙 후보를 찾습니다.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              현재는 빠른 검증을 위해 핵심 유니버스를 우선 스캔합니다. 이후 관심종목 기반으로 확장할 수 있습니다.
            </p>
            <Button
              onClick={() => void swingScreenerQuery.refetch()}
              disabled={swingScreenerQuery.isFetching}
              className="gap-2"
            >
              {swingScreenerQuery.isFetching ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  스캔 중...
                </>
              ) : (
                "오늘의 후보 찾기"
              )}
            </Button>
          </div>

          {swingBible.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2">
              {swingBible.map((pattern) => (
                <div key={pattern.name} className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="font-semibold">{pattern.name}</h4>
                    <Badge variant="outline">바이블</Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{pattern.summary}</p>
                  <div className="mt-3 space-y-2 text-sm">
                    <p className="font-medium">체크리스트</p>
                    <ul className="list-disc pl-5 text-muted-foreground">
                      {pattern.checklist.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <p><span className="font-medium">진입:</span> {pattern.entryRule}</p>
                    <p><span className="font-medium">리스크:</span> {pattern.riskRule}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {swingCandidates.length > 0 ? (
            <div className="grid gap-3">
              {swingCandidates.map((candidate) => (
                <button
                  key={candidate.ticker}
                  onClick={() => {
                    setTicker(candidate.ticker);
                    void runAnalysis(candidate.ticker);
                  }}
                  className="rounded-lg border p-4 text-left transition-colors hover:bg-muted/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-semibold">
                          {candidate.companyName} ({candidate.ticker})
                        </h4>
                        <Badge>{candidate.swingFit}</Badge>
                        <Badge variant="outline">{candidate.swingScore}점</Badge>
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {candidate.patterns.join(" · ")}
                      </p>
                    </div>
                    <div className="text-sm text-right text-muted-foreground">
                      <p>현재가 {candidate.currentPrice.toLocaleString("ko-KR")}원</p>
                      <p>트리거 {candidate.triggerPrice.toLocaleString("ko-KR")}원</p>
                      <p>손절 {candidate.stopLossPrice.toLocaleString("ko-KR")}원</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <Badge variant="secondary">거래량 {candidate.volumeRatio}배</Badge>
                    <Badge variant="secondary">RSI {candidate.rsi14}</Badge>
                  </div>
                  <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                    {candidate.reason.map((line) => (
                      <p key={line}>- {line}</p>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Search Section */}
      <Card>
        <CardHeader>
          <CardTitle>주식 분석</CardTitle>
          <CardDescription>한국 종목은 `005930`처럼 입력해 차트, 거래량, 인디케이터 중심의 기술적 스윙 분석을 받아보세요.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="한국 종목 코드 입력 (예: 005930, 035720, 000660)"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleAnalyze()}
              disabled={isLoading}
            />
            <Button onClick={handleAnalyze} disabled={isLoading || !ticker.trim()} className="gap-2">
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  분석 중...
                </>
              ) : (
                "분석 시작"
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Analysis Results */}
      {currentAnalysis && (
        <div className="space-y-4">
          {/* Header */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-2xl">
                    {currentAnalysis.companyName && currentAnalysis.companyName !== currentAnalysis.ticker
                      ? `${currentAnalysis.companyName} (${currentAnalysis.ticker})`
                      : currentAnalysis.ticker}
                  </CardTitle>
                  <CardDescription>
                    분석 완료 · 한국 주식 전용 스윙 분석
                  </CardDescription>
                  {currentAnalysis.dataQuality?.usedFallbackData ? (
                    <p className="text-xs text-amber-600 mt-2">
                      실시간 데이터 일부를 가져오지 못했습니다. 아래 분석은 확보된 실데이터와 대체 데이터가 함께 반영된 결과입니다.
                    </p>
                  ) : null}
                  {currentAnalysis.dataQuality?.sources ? (
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <Badge variant="outline">
                        기업정보: {currentAnalysis.dataQuality.sources.profile === "live" ? "실시간" : "대체"}
                      </Badge>
                      <Badge variant="outline">
                        가격데이터: {currentAnalysis.dataQuality.sources.chart === "live" ? "실시간" : "대체"}
                      </Badge>
                      <Badge variant="outline">
                        투자판단 데이터: {currentAnalysis.dataQuality.sources.insights === "live" ? "실시간" : "보완해석"}
                      </Badge>
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <Badge className="bg-blue-100 text-blue-800">
                    스윙 적합 점수: {framework?.asymmetricGrowthScore ?? 0}점
                  </Badge>
                  <Button size="sm" onClick={handleAddToWatchlist} variant="outline">
                    관심종목 추가
                  </Button>
                </div>
              </div>
            </CardHeader>
          </Card>

          {/* Framework Analysis */}
          <Card>
            <CardHeader>
              <CardTitle>스윙 매매 프레임워크</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {framework?.systemThinking && (
                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle className="h-4 w-4 text-green-600" />
                      <h4 className="font-semibold">차트 구조 판단</h4>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {framework.systemThinking}
                    </p>
                  </div>
                )}

                {framework?.longTermVision && (
                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingUp className="h-4 w-4 text-blue-600" />
                      <h4 className="font-semibold">스윙 시나리오</h4>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {framework.longTermVision}
                    </p>
                  </div>
                )}

                {framework?.leverageFactors?.length ? (
                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <AlertCircle className="h-4 w-4 text-orange-600" />
                      <h4 className="font-semibold">강점 신호</h4>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {framework.leverageFactors.join(", ")}
                    </p>
                  </div>
                ) : null}

                {framework?.asymmetricOpportunities?.length ? (
                  <div className="p-4 border rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingUp className="h-4 w-4 text-purple-600" />
                      <h4 className="font-semibold">스윙 기회 요인</h4>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {framework.asymmetricOpportunities.join(" / ")}
                    </p>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* Investment Insight */}
          <Card>
            <CardHeader>
              <CardTitle>투자 인사이트</CardTitle>
              <CardDescription>실제로 무엇을 확인하고 어떻게 접근할지에 초점을 맞춘 투자 메모입니다.</CardDescription>
            </CardHeader>
            <CardContent>
              {currentAnalysis.dataQuality?.warnings?.length ? (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  {currentAnalysis.dataQuality.warnings.join(" ")}
                </div>
              ) : null}
              <div className="prose prose-sm max-w-none">
                <Streamdown>{currentAnalysis.investmentInsight}</Streamdown>
              </div>
            </CardContent>
          </Card>

          {/* AI Agent Reports */}
          <Card>
            <CardHeader>
              <CardTitle>AI 에이전트 분석 리포트</CardTitle>
              <CardDescription>5가지 역할의 AI 에이전트가 제공하는 전문 분석</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="fundamental" className="w-full">
                <TabsList className="grid w-full grid-cols-5">
                  <TabsTrigger value="fundamental">패턴</TabsTrigger>
                  <TabsTrigger value="technical">지표</TabsTrigger>
                  <TabsTrigger value="insider">거래량</TabsTrigger>
                  <TabsTrigger value="risk">리스크</TabsTrigger>
                  <TabsTrigger value="market">스윙메모</TabsTrigger>
                </TabsList>

                <TabsContent value="fundamental" className="mt-4">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <h4 className="font-semibold text-blue-900 mb-2">패턴 구조 분석</h4>
                    <div className="prose prose-sm max-w-none text-blue-800">
                      <Streamdown>{currentAnalysis.fundamentalAnalysis || "분석 진행 중..."}</Streamdown>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="technical" className="mt-4">
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                    <h4 className="font-semibold text-green-900 mb-2">인디케이터 분석</h4>
                    <div className="prose prose-sm max-w-none text-green-800">
                      <Streamdown>{currentAnalysis.technicalAnalysis || "분석 진행 중..."}</Streamdown>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="insider" className="mt-4">
                  <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <h4 className="font-semibold text-yellow-900 mb-2">
                      거래량 / 수급 분석
                    </h4>
                    <div className="prose prose-sm max-w-none text-yellow-800">
                      <Streamdown>{currentAnalysis.insiderAnalysis || "분석 진행 중..."}</Streamdown>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="risk" className="mt-4">
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                    <h4 className="font-semibold text-red-900 mb-2">리스크 관리자</h4>
                    <div className="prose prose-sm max-w-none text-red-800">
                      <Streamdown>{currentAnalysis.riskAnalysis || "분석 진행 중..."}</Streamdown>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="market" className="mt-4">
                  <div className="p-4 bg-violet-50 border border-violet-200 rounded-lg">
                    <h4 className="font-semibold text-violet-900 mb-2">스윙 매매 메모</h4>
                    <div className="prose prose-sm max-w-none text-violet-800">
                      <Streamdown>{currentAnalysis.marketIntelligenceAnalysis || "분석 진행 중..."}</Streamdown>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recent Analyses */}
      {!currentAnalysis && historyQuery.data && historyQuery.data.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>최근 분석</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {historyQuery.data.slice(0, 5).map((analysis: any) => (
                <button
                  key={analysis.id}
                  onClick={() => {
                    setTicker(analysis.ticker);
                    void runAnalysis(analysis.ticker);
                  }}
                  className="w-full text-left p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{analysis.ticker}</span>
                    <Badge>{analysis.asymmetricGrowthScore}점</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {new Date(analysis.analysisDate).toLocaleDateString("ko-KR")}
                  </p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!currentAnalysis && (!historyQuery.data || historyQuery.data.length === 0) && (
        <Card>
          <CardContent className="pt-12 text-center">
            <p className="text-muted-foreground mb-4">아직 분석한 종목이 없습니다.</p>
            <p className="text-sm text-muted-foreground">위에서 종목 티커를 입력하여 분석을 시작하세요.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
