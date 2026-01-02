import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import crypto from "crypto";
import { KALSHI_CONFIG } from "@/lib/kalshi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes for processing all wins

// Helper to make authenticated Kalshi API calls
async function kalshiFetch(endpoint: string): Promise<any> {
  const timestampMs = Date.now().toString();
  const method = "GET";
  const pathWithoutQuery = endpoint.split("?")[0];
  const fullPath = `/trade-api/v2${pathWithoutQuery}`;

  const message = `${timestampMs}${method}${fullPath}`;
  const privateKey = crypto.createPrivateKey(KALSHI_CONFIG.privateKey);
  const signature = crypto
    .sign("sha256", Buffer.from(message), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");

  const response = await fetch(`${KALSHI_CONFIG.baseUrl}${endpoint}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": KALSHI_CONFIG.apiKey,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

interface WinWithLow {
  ticker: string;
  title: string;
  side: string;
  entry_price: number;
  min_price: number | null;
  hit_50: boolean;
  hit_60: boolean;
  hit_70: boolean;
  hit_80: boolean;
  cost_cents: number;
  payout_cents: number;
}

// GET - Analyze candlesticks for all wins
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "500");
    
    // Get all won orders
    const { data: wonOrders, error } = await supabase
      .from("orders")
      .select("id, ticker, event_ticker, title, side, price_cents, executed_price_cents, executed_cost_cents, cost_cents, actual_payout_cents, potential_payout_cents, placement_status_at, market_close_time")
      .eq("placement_status", "confirmed")
      .eq("result_status", "won")
      .order("placement_status_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ success: false, error: error.message });
    }

    console.log(`[Candlestick Analysis] Found ${wonOrders?.length} won orders`);

    const results: WinWithLow[] = [];
    const errors: string[] = [];
    let processed = 0;
    let withCandlesticks = 0;
    let hit50Count = 0;
    let hit60Count = 0;
    let hit70Count = 0;
    let hit80Count = 0;

    // Process in batches to avoid rate limits
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 1000; // 1 second between batches

    for (let i = 0; i < (wonOrders?.length || 0); i += BATCH_SIZE) {
      const batch = wonOrders!.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (order) => {
        processed++;
        
        try {
          // Extract series_ticker from event_ticker
          const seriesTicker = order.event_ticker?.split("-")[0] || "";
          const marketTicker = order.ticker;
          const userSide = order.side; // 'YES' or 'NO'

          if (!seriesTicker || !marketTicker) {
            return;
          }

          // Calculate time range
          const placementTime = order.placement_status_at
            ? Math.floor(new Date(order.placement_status_at).getTime() / 1000)
            : null;
          const closeTime = order.market_close_time
            ? Math.floor(new Date(order.market_close_time).getTime() / 1000)
            : Math.floor(Date.now() / 1000);

          const startTs = placementTime
            ? placementTime - 2 * 60 * 60
            : closeTime - 48 * 60 * 60;
          const endTs = closeTime;

          const url = `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=60`;

          const response = await kalshiFetch(url);

          if (!response?.candlesticks || response.candlesticks.length === 0) {
            return;
          }

          withCandlesticks++;

          // Calculate min price for user's side
          let minPrice = 100;

          for (const c of response.candlesticks) {
            const yesHigh = c.price?.high ?? c.price?.max ?? c.yes_bid?.high ?? 0;
            const yesLow = c.price?.low ?? c.price?.min ?? c.yes_bid?.low ?? 0;

            if (userSide === "YES") {
              if (yesLow > 0 && yesLow < minPrice) minPrice = yesLow;
            } else {
              // For NO side: our low = 100 - YES high
              const noLow = yesHigh > 0 ? 100 - yesHigh : 0;
              if (noLow > 0 && noLow < minPrice) minPrice = noLow;
            }
          }

          const entryPrice = order.executed_price_cents || order.price_cents;
          const hit50 = minPrice <= 50;
          const hit60 = minPrice <= 60;
          const hit70 = minPrice <= 70;
          const hit80 = minPrice <= 80;

          if (hit50) hit50Count++;
          if (hit60) hit60Count++;
          if (hit70) hit70Count++;
          if (hit80) hit80Count++;

          results.push({
            ticker: order.ticker,
            title: order.title || order.ticker,
            side: userSide,
            entry_price: entryPrice,
            min_price: minPrice < 100 ? minPrice : null,
            hit_50: hit50,
            hit_60: hit60,
            hit_70: hit70,
            hit_80: hit80,
            cost_cents: order.executed_cost_cents || order.cost_cents || 0,
            payout_cents: order.actual_payout_cents || order.potential_payout_cents || 0,
          });

        } catch (e) {
          errors.push(`Error processing ${order.ticker}: ${e}`);
        }
      }));

      // Rate limit between batches
      if (i + BATCH_SIZE < (wonOrders?.length || 0)) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
      
      console.log(`[Candlestick Analysis] Processed ${Math.min(i + BATCH_SIZE, wonOrders?.length || 0)} / ${wonOrders?.length}`);
    }

    // Sort results by min_price ascending (lowest first)
    results.sort((a, b) => (a.min_price || 100) - (b.min_price || 100));

    // Get wins that hit 50
    const winsHit50 = results.filter(r => r.hit_50);

    return NextResponse.json({
      success: true,
      summary: {
        total_wins: wonOrders?.length || 0,
        processed: processed,
        with_candlesticks: withCandlesticks,
        hit_50: hit50Count,
        hit_60: hit60Count,
        hit_70: hit70Count,
        hit_80: hit80Count,
        hit_50_pct: withCandlesticks > 0 ? ((hit50Count / withCandlesticks) * 100).toFixed(1) : "0",
        hit_60_pct: withCandlesticks > 0 ? ((hit60Count / withCandlesticks) * 100).toFixed(1) : "0",
        hit_70_pct: withCandlesticks > 0 ? ((hit70Count / withCandlesticks) * 100).toFixed(1) : "0",
        hit_80_pct: withCandlesticks > 0 ? ((hit80Count / withCandlesticks) * 100).toFixed(1) : "0",
      },
      wins_hit_50: winsHit50,
      all_results: results,
      errors: errors.slice(0, 10), // Only show first 10 errors
    });
  } catch (e) {
    console.error("[Candlestick Analysis] Error:", e);
    return NextResponse.json({
      success: false,
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
}

