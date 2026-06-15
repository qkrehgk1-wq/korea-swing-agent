import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, Trash2, TrendingUp, Calendar } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const PENDING_TICKER_KEY = "pending-analysis-ticker";

export default function AnalysisHistory() {
  const [searchTicker, setSearchTicker] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "score">("date");

  const historyQuery = trpc.stocks.getHistory.useQuery();
  const removeWatchlistMutation = trpc.watchlist.remove.useMutation();

  const filteredHistory =
    historyQuery.data
      ?.filter((analysis: any) =>
        analysis.ticker.toUpperCase().includes(searchTicker.toUpperCase())
      )
      .sort((a: any, b: any) => {
        if (sortBy === "score") {
          return (b.asymmetricGrowthScore || 0) - (a.asymmetricGrowthScore || 0);
        }
        return new Date(b.analysisDate).getTime() - new Date(a.analysisDate).getTime();
      }) || [];

  const handleRemoveFromWatchlist = async (ticker: string) => {
    try {
      await removeWatchlistMutation.mutateAsync({ ticker });
      historyQuery.refetch();
      toast.success(`${ticker}를 관심종목에서 제거했습니다.`);
    } catch (error) {
      console.error("Remove error:", error);
      toast.error("관심종목 제거에 실패했습니다.");
    }
  };

  const openTickerInAnalysis = (ticker: string) => {
    sessionStorage.setItem(PENDING_TICKER_KEY, ticker);
    window.location.href = "/dashboard/analysis";
  };

  const getScoreBadgeColor = (score: number) => {
    if (score >= 85) return "bg-green-100 text-green-800";
    if (score >= 75) return "bg-blue-100 text-blue-800";
    if (score >= 65) return "bg-yellow-100 text-yellow-800";
    return "bg-red-100 text-red-800";
  };

  const stats = {
    total: filteredHistory.length,
    highOpportunity: filteredHistory.filter((a: any) => (a.asymmetricGrowthScore || 0) >= 80)
      .length,
    avgScore: filteredHistory.length
      ? Math.round(
          filteredHistory.reduce((sum: number, a: any) => sum + (a.asymmetricGrowthScore || 0), 0) /
            filteredHistory.length
        )
      : 0,
  };

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">총 분석 건수</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.total}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              높은 기회 (80점 이상)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-600">{stats.highOpportunity}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">평균 점수</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats.avgScore}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>분석 이력</CardTitle>
          <CardDescription>과거 분석 결과를 조회하고 관리합니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="종목 티커 검색..."
              value={searchTicker}
              onChange={(e) => setSearchTicker(e.target.value)}
            />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "date" | "score")}
              className="px-3 py-2 border rounded-md bg-background"
            >
              <option value="date">최신순</option>
              <option value="score">점수순</option>
            </select>
          </div>
        </CardContent>
      </Card>

      {/* History List */}
      {historyQuery.isLoading ? (
        <Card>
          <CardContent className="pt-12 text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
            <p className="text-muted-foreground">분석 이력을 불러오는 중...</p>
          </CardContent>
        </Card>
      ) : filteredHistory.length > 0 ? (
        <div className="space-y-3">
          {filteredHistory.map((analysis: any) => (
            <Card key={analysis.id} className="hover:shadow-md transition-shadow">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-semibold">{analysis.ticker}</h3>
                      <Badge className={getScoreBadgeColor(analysis.asymmetricGrowthScore || 0)}>
                        {analysis.asymmetricGrowthScore || 0}점
                      </Badge>
                    </div>

                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <div className="flex items-center gap-1">
                        <Calendar className="h-4 w-4" />
                        {new Date(analysis.analysisDate).toLocaleDateString("ko-KR", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </div>

                      {analysis.asymmetricGrowthScore >= 80 && (
                        <div className="flex items-center gap-1 text-green-600">
                          <TrendingUp className="h-4 w-4" />
                          높은 성장 기회
                        </div>
                      )}
                    </div>

                    {analysis.investmentInsight && (
                      <p className="mt-3 text-sm line-clamp-2 text-muted-foreground">
                        {analysis.investmentInsight}
                      </p>
                    )}
                  </div>

                  <div className="flex gap-2 ml-4">
                    <Button size="sm" variant="outline" onClick={() => openTickerInAnalysis(analysis.ticker)}>
                      분석 열기
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      title="관심종목에서 제거"
                      onClick={() => handleRemoveFromWatchlist(analysis.ticker)}
                      disabled={removeWatchlistMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="pt-12 text-center">
            <p className="text-muted-foreground mb-4">분석 이력이 없습니다.</p>
            <p className="text-sm text-muted-foreground">
              {searchTicker ? "검색 조건을 변경해보세요." : "종목을 분석하여 이력을 생성하세요."}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Top Opportunities */}
      {filteredHistory.length > 0 && stats.highOpportunity > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>상위 기회 종목</CardTitle>
            <CardDescription>비대칭적 성장 점수가 높은 종목들</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {filteredHistory
                .filter((a: any) => (a.asymmetricGrowthScore || 0) >= 80)
                .slice(0, 5)
                .map((analysis: any) => (
                  <div
                    key={analysis.id}
                    className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50"
                  >
                    <div>
                      <p className="font-semibold">{analysis.ticker}</p>
                      <p className="text-sm text-muted-foreground">
                        {new Date(analysis.analysisDate).toLocaleDateString("ko-KR")}
                      </p>
                    </div>
                    <Badge className="bg-green-100 text-green-800">
                      {analysis.asymmetricGrowthScore}점
                    </Badge>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
