import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

// GET - Fetch candlestick analysis from database (fast)
export async function GET() {
  try {
    console.log("[Candlestick Analysis] Fetching from order_candlesticks table...");
    
    // Simple query - get all rows from order_candlesticks
    const { data: cached, error } = await supabase
      .from("order_candlesticks")
      .select("ticker, title, side, entry_price_cents, min_price_cents, cost_cents, payout_cents, result_status");

    if (error) {
      console.error("[Candlestick Analysis] DB Error:", error);
      return NextResponse.json({ success: false, error: error.message });
    }

    console.log(`[Candlestick Analysis] Got ${cached?.length || 0} rows from DB`);

    // Filter to only won orders with valid min_price_cents
    const validData = (cached || []).filter(c => 
      c.result_status === "won" && c.min_price_cents !== null
    );

    console.log(`[Candlestick Analysis] ${validData.length} valid rows after filtering`);

    const withCandlesticks = validData.length;

    // Count hits at each threshold - min_price_cents is in cents (e.g., 50 = 50¢)
    const hit50Count = validData.filter(c => c.min_price_cents <= 50).length;
    const hit60Count = validData.filter(c => c.min_price_cents <= 60).length;
    const hit70Count = validData.filter(c => c.min_price_cents <= 70).length;
    const hit80Count = validData.filter(c => c.min_price_cents <= 80).length;

    // Build all_results array matching frontend format
    const allResults: WinWithLow[] = validData.map(c => ({
      ticker: c.ticker,
      title: c.title || c.ticker,
      side: c.side || "YES",
      entry_price: c.entry_price_cents || 0,
      min_price: c.min_price_cents,
      hit_50: c.min_price_cents <= 50,
      hit_60: c.min_price_cents <= 60,
      hit_70: c.min_price_cents <= 70,
      hit_80: c.min_price_cents <= 80,
      cost_cents: c.cost_cents || 0,
      payout_cents: c.payout_cents || 0,
    })).sort((a, b) => (a.min_price || 100) - (b.min_price || 100));

    // wins_hit_50 are the ones that dipped to 50¢ or below
    const winsHit50 = allResults.filter(r => r.hit_50);

    return NextResponse.json({
      success: true,
      summary: {
        total_wins: validData.length,
        processed: validData.length,
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
      errors: [] as string[],
    });
  } catch (e) {
    console.error("[Candlestick Analysis] Error:", e);
    return NextResponse.json({
      success: false,
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
}
