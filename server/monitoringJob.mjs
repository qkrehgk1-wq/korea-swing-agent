import "dotenv/config";

/**
 * Standalone Monitoring Job for GitHub Actions
 * Monitors the Korean-equity watchlist for notable price/volume changes,
 * then runs the daily technical swing scan and delivers recommendations.
 */

import { monitorWatchlist } from './watchlistMonitor.js';
import { notifyDailyMarketSummary, notifyDailySwingCandidates, notifyDailySwingFailure } from './notificationService.js';
import { getAllWatchlist } from './db.js';
import { screenTechnicalSwingCandidates } from './technicalSwingScreener.js';

async function runMonitoringJob() {
  console.log('[Monitoring Job] Starting watchlist monitoring job...');

  try {
    console.log('[Monitoring Job] Fetching watchlist items...');
    const watchlistItems = await getAllWatchlist();

    if (watchlistItems.length) {
      console.log(`[Monitoring Job] Found ${watchlistItems.length} watchlist items`);

      // Single pass: monitor + dedupe + summarize.
      const summaries = await monitorWatchlist(watchlistItems);

      const alerted = summaries.filter((item) => item.alerts > 0);
      const totalSignals = summaries.reduce((sum, item) => sum + item.alerts, 0);
      const topMovers = alerted
        .sort((a, b) => b.alerts - a.alerts)
        .slice(0, 3)
        .map((item) => ({
          ticker: item.ticker,
          score: 60 + Math.min(item.alerts * 10, 35),
        }));

      await notifyDailyMarketSummary(topMovers, alerted.length, totalSignals);
      console.log(`[Monitoring Job] Summary: ${totalSignals} signals across ${alerted.length} stocks`);
    } else {
      console.log('[Monitoring Job] No watchlist items found, continuing with swing scan');
    }

    const swingScreener = await screenTechnicalSwingCandidates();
    const swingDelivery = await notifyDailySwingCandidates(swingScreener.candidates);

    if (!swingScreener.candidates.length) {
      console.log('[Monitoring Job] Swing scan finished with no qualified candidates');
      console.log(`[Monitoring Job] Notes: ${swingScreener.notes.join(' | ')}`);
      await notifyDailySwingFailure(swingScreener.notes);
    } else if (!swingDelivery.primaryDelivered) {
      console.log('[Monitoring Job] Swing candidates found but Telegram delivery failed');
      await notifyDailySwingFailure(
        [
          '상위 스윙 후보는 산출됐지만 텔레그램 전송이 실패했습니다.',
          `실패 채널: ${swingDelivery.failedChannels.join(', ') || 'telegram'}`,
        ],
        '텔레그램 전송 실패'
      );
    } else {
      console.log(`[Monitoring Job] Swing scan completed with ${swingScreener.candidates.length} candidates`);
    }

    console.log('[Monitoring Job] Monitoring job completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('[Monitoring Job] Fatal error:', error);
    process.exit(1);
  }
}

runMonitoringJob();
