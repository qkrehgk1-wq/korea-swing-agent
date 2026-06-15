import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Loader2, X, TrendingUp } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export default function ComparisonAnalysis() {
  const [tickers, setTickers] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isComparing, setIsComparing] = useState(false);
  const [comparisonResults, setComparisonResults] = useState<any[]>([]);

  const historyQuery = trpc.stocks.getHistory.useQuery();
  const analyzeMutation = trpc.stocks.analyze.useMutation();

  const handleAddTicker = () => {
    const code = inputValue.trim();
    if (!/^\d{6}$/.test(code)) {
      toast.error("한국 종목 코드 6자리를 입력하세요 (예: 005930).");
      return;
    }
    if (tickers.includes(code)) {
      setInputValue("");
      return;
    }
    if (tickers.length < 5) {
      setTickers([...tickers, code]);
      setInputValue("");
    }
  };

  const handleRemoveTicker = (ticker: string) => {
    setTickers(tickers.filter((t) => t !== ticker));
  };

  const handleCompare = async () => {
    if (tickers.length < 2) return;

    setIsComparing(true);

    try {
      // Fetch analysis for each ticker from history or perform new analysis
      const results = await Promise.all(
        tickers.map(async (ticker) => {
          const analysisResult = await analyzeMutation.mutateAsync({ ticker });
          if (analysisResult) {
            return {
              ticker,
              score: analysisResult.framework.asymmetricGrowthScore,
              framework: analysisResult.framework,
              insight: analysisResult.investmentInsight,
            };
          }
          throw new Error(`${ticker} 분석 결과를 가져오지 못했습니다.`);
        })
      );

      setComparisonResults(results);
      historyQuery.refetch();
    } catch (error) {
      console.error("Comparison error:", error);
      toast.error("비교 분석에 실패했습니다. 다시 시도해주세요.");
    } finally {
      setIsComparing(false);
    }
  };

  const metrics = [
    { name: "스윙 적합 점수", key: "asymmetricGrowthScore", weight: 1 },
    { name: "차트 구조 판단", key: "systemThinking", weight: 0.8 },
    { name: "스윙 시나리오", key: "longTermVision", weight: 0.8 },
    { name: "강점 신호", key: "leverageFactors", weight: 0.7 },
  ];

  const getScoreBadgeColor = (score: number) => {
    if (score >= 85) return "bg-green-100 text-green-800";
    if (score >= 75) return "bg-blue-100 text-blue-800";
    if (score >= 65) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  return (
    <div className="space-y-6">
      {/* Input Section */}
      <Card>
        <CardHeader>
          <CardTitle>종목 비교 분석</CardTitle>
          <CardDescription>
            여러 한국 종목을 선택해 스윙 적합도 기준으로 비교합니다. (최대 5개)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="한국 종목 코드 입력 (예: 005930)"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && handleAddTicker()}
              disabled={tickers.length >= 5}
            />
            <Button onClick={handleAddTicker} disabled={tickers.length >= 5}>
              추가
            </Button>
          </div>

          {/* Selected Tickers */}
          {tickers.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {tickers.map((ticker) => (
                <Badge key={ticker} variant="secondary" className="px-3 py-1 gap-2">
                  {ticker}
                  <button
                    onClick={() => handleRemoveTicker(ticker)}
                    className="ml-1 hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}

          <Button
            onClick={handleCompare}
            disabled={tickers.length < 2 || isComparing}
            className="w-full gap-2"
          >
            {isComparing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                비교 분석 중...
              </>
            ) : (
              `${tickers.length}개 종목 비교 분석`
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Comparison Results */}
      {comparisonResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>스윙 적합도 비교</CardTitle>
            <CardDescription>
              스윙 매매 프레임워크 기준으로 한국 종목을 평가합니다.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              {/* Score Comparison */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-4 font-semibold">평가 지표</th>
                      {comparisonResults.map((result) => (
                        <th key={result.ticker} className="text-center py-2 px-4 font-semibold">
                          {result.ticker}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b hover:bg-muted/50">
                      <td className="py-3 px-4 font-medium">스윙 적합 점수</td>
                      {comparisonResults.map((result) => {
                        const score = result.score || 0;
                        return (
                          <td
                            key={result.ticker}
                            className={`text-center py-3 px-4 ${getScoreBadgeColor(score)}`}
                          >
                            <span className="font-semibold">{score}</span>
                          </td>
                        );
                      })}
                    </tr>

                    {/* Framework Comparison */}
                    {metrics.slice(1).map((metric) => (
                      <tr key={metric.key} className="border-b hover:bg-muted/50">
                        <td className="py-3 px-4 font-medium text-sm">{metric.name}</td>
                        {comparisonResults.map((result) => {
                          const hasMetric = result.framework[metric.key] ? "✓" : "○";
                          const bgColor = hasMetric === "✓" ? "bg-green-50" : "bg-gray-50";
                          return (
                            <td key={result.ticker} className={`text-center py-3 px-4 ${bgColor}`}>
                              <span className="text-lg">{hasMetric}</span>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Detailed Comparison */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {comparisonResults.map((result) => (
                  <Card key={result.ticker} className="border-2">
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg">{result.ticker}</CardTitle>
                        <Badge className={getScoreBadgeColor(result.score)}>
                          {result.score}점
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <div className="p-3 bg-blue-50 border border-blue-200 rounded">
                        <p className="font-semibold text-blue-900 mb-1">투자 인사이트</p>
                        <p className="text-blue-800 line-clamp-3">{result.insight}</p>
                      </div>

                      {result.framework.asymmetricGrowthScore && (
                        <div className="flex items-center gap-2">
                          <TrendingUp className="h-4 w-4 text-purple-600" />
                          <span className="text-muted-foreground">
                            스윙 적합도 양호
                          </span>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Summary */}
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <h4 className="font-semibold text-blue-900 mb-2">비교 분석 요약</h4>
                <ul className="text-sm text-blue-800 space-y-1">
                  {comparisonResults
                    .sort((a, b) => (b.score || 0) - (a.score || 0))
                    .map((result, idx) => (
                      <li key={result.ticker}>
                        • <strong>{idx + 1}위:</strong> {result.ticker} ({result.score}점)
                      </li>
                    ))}
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {tickers.length === 0 && comparisonResults.length === 0 && (
        <Card>
          <CardContent className="pt-12 text-center">
            <p className="text-muted-foreground mb-4">아직 비교할 종목을 선택하지 않았습니다.</p>
            <p className="text-sm text-muted-foreground">위에서 종목을 추가하여 비교 분석을 시작하세요.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
