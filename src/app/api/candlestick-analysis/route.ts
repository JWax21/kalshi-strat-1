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

// Helper to build the response from cached data
function buildResponseFromCache(cached: any[]) {
  const withCandlesticks = cached.length;
  
  // Count hits at each threshold - min_price_cents is in cents (e.g., 50 = 50¢)
  const hit50Count = cached.filter(c => (c.min_price_cents || 100) <= 50).length;
  const hit60Count = cached.filter(c => (c.min_price_cents || 100) <= 60).length;
  const hit70Count = cached.filter(c => (c.min_price_cents || 100) <= 70).length;
  const hit80Count = cached.filter(c => (c.min_price_cents || 100) <= 80).length;

  // Build all_results array matching frontend format
  const allResults: WinWithLow[] = cached.map(c => {
    const minPrice = c.min_price_cents; // Already in cents
    return {
      ticker: c.ticker,
      title: c.title || c.ticker,
      side: c.side,
      entry_price: c.entry_price_cents || 0, // in cents
      min_price: minPrice,
      hit_50: (minPrice || 100) <= 50,
      hit_60: (minPrice || 100) <= 60,
      hit_70: (minPrice || 100) <= 70,
      hit_80: (minPrice || 100) <= 80,
      cost_cents: c.cost_cents || 0,
      payout_cents: c.payout_cents || 0,
    };
  }).sort((a, b) => (a.min_price || 100) - (b.min_price || 100));

  // wins_hit_50 are the ones that dipped to 50¢ or below
  const winsHit50 = allResults.filter(r => r.hit_50);

  return {
    success: true,
    summary: {
      total_wins: cached.length,
      processed: cached.length,
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
    all_results: allResults,
    errors: [],
  };
}

// GET - Analyze candlesticks for all wins (uses cache)
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const refresh = url.searchParams.get("refresh") === "true";
    
    // First, try to get cached data from order_candlesticks table
    if (!refresh) {
      const { data: cached, error: cacheError } = await supabase
        .from("order_candlesticks")
        .select("*")
        .eq("result_status", "won")
        .not("min_price_cents", "is", null);
      
      if (!cacheError && cached && cached.length > 0) {
        console.log(`[Candlestick Analysis] Using ${cached.length} cached results from DB`);
        return NextResponse.json(buildResponseFromCache(cached));
      }
    }
    
    // Get all won orders that don't have cached candlestick data
    const { data: wonOrders, error } = await supabase
      .from("orders")
      .select("id, ticker, event_ticker, title, side, price_cents, executed_price_cents, executed_cost_cents, cost_cents, actual_payout_cents, potential_payout_cents, placement_status_at, market_close_time")
      .eq("placement_status", "confirmed")
      .eq("result_status", "won")
      .order("placement_status_at", { ascending: false })
      .limit(500);

    if (error) {
      return NextResponse.json({ success: false, error: error.message });
    }

    // Check which ones we already have cached
    const { data: existingCache } = await supabase
      .from("order_candlesticks")
      .select("ticker")
      .in("ticker", wonOrders?.map(o => o.ticker) || []);
    
    const cachedTickers = new Set(existingCache?.map(c => c.ticker) || []);
    const ordersToProcess = wonOrders?.filter(o => !cachedTickers.has(o.ticker)) || [];

    console.log(`[Candlestick Analysis] Found ${wonOrders?.length} won orders, ${ordersToProcess.length} need processing`);

    const errors: string[] = [];
    let processed = 0;

    // Process in batches to avoid rate limits
    const BATCH_SIZE = 10;
    const BATCH_DELAY = 1000;

    for (let i = 0; i < ordersToProcess.length; i += BATCH_SIZE) {
      const batch = ordersToProcess.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (order) => {
        processed++;
        
        try {
          const seriesTicker = order.event_ticker?.split("-")[0] || "";
          const marketTicker = order.ticker;
          const userSide = order.side;

          if (!seriesTicker || !marketTicker) return;

          const placementTime = order.placement_status_at
            ? Math.floor(new Date(order.placement_status_at).getTime() / 1000)
            : null;
          const closeTime = order.market_close_time
            ? Math.floor(new Date(order.market_close_time).getTime() / 1000)
            : Math.floor(Date.now() / 1000);

          const startTs = placementTime ? placementTime - 2 * 60 * 60 : closeTime - 48 * 60 * 60;
          const endTs = closeTime;

          const candlestickUrl = `/series/${seriesTicker}/markets/${marketTicker}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=60`;
          const response = await kalshiFetch(candlestickUrl);

          if (!response?.candlesticks || response.candlesticks.length === 0) return;

          let minPrice = 100;
          let maxPrice = 0;

          for (const c of response.candlesticks) {
            const yesHigh = c.price?.high ?? c.price?.max ?? c.yes_bid?.high ?? 0;
            const yesLow = c.price?.low ?? c.price?.min ?? c.yes_bid?.low ?? 0;

            if (userSide === "YES") {
              if (yesLow > 0 && yesLow < minPrice) minPrice = yesLow;
              if (yesHigh > maxPrice) maxPrice = yesHigh;
            } else {
              const noLow = yesHigh > 0 ? 100 - yesHigh : 0;
              const noHigh = yesLow > 0 ? 100 - yesLow : 0;
              if (noLow > 0 && noLow < minPrice) minPrice = noLow;
              if (noHigh > maxPrice) maxPrice = noHigh;
            }
          }

          const entryPrice = order.executed_price_cents || order.price_cents;
          const costCents = order.executed_cost_cents || order.cost_cents || 0;
          const payoutCents = order.actual_payout_cents || order.potential_payout_cents || 0;

          // Save to cache - min_price_cents stored in cents (e.g., 50 = 50¢)
          await supabase.from("order_candlesticks").upsert({
            ticker: order.ticker,
            event_ticker: order.event_ticker,
            title: order.title,
            side: userSide,
            entry_price_cents: entryPrice,
            min_price_cents: minPrice < 100 ? minPrice : null,
            max_price_cents: maxPrice > 0 ? maxPrice : null,
            candlestick_count: response.candlesticks.length,
            hit_50: minPrice <= 50,
            hit_60: minPrice <= 60,
            hit_70: minPrice <= 70,
            hit_80: minPrice <= 80,
            result_status: "won",
            cost_cents: costCents,
            payout_cents: payoutCents,
            analyzed_at: new Date().toISOString(),
          }, { onConflict: "ticker" });

        } catch (e) {
          errors.push(`Error processing ${order.ticker}: ${e}`);
        }
      }));

      if (i + BATCH_SIZE < ordersToProcess.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
      
      console.log(`[Candlestick Analysis] Processed ${Math.min(i + BATCH_SIZE, ordersToProcess.length)} / ${ordersToProcess.length}`);
    }

    // Now get ALL cached data (including what we just added)
    const { data: allCached } = await supabase
      .from("order_candlesticks")
      .select("*")
      .eq("result_status", "won")
      .not("min_price_cents", "is", null);

    console.log(`[Candlestick Analysis] Processed ${processed} new orders, returning ${allCached?.length || 0} total`);
    
    // Use the same format builder for consistency
    const response = buildResponseFromCache(allCached || []);
    response.errors = errors.slice(0, 10);
    return NextResponse.json(response);
  } catch (e) {
    console.error("[Candlestick Analysis] Error:", e);
    return NextResponse.json({
      success: false,
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
}

