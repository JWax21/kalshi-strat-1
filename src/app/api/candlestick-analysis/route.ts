import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET - Fetch candlestick analysis from database (fast)
export async function GET() {
  try {
    console.log("[Candlestick Analysis] Fetching from order_candlesticks table...");
    
    // Simple query - get all rows from order_candlesticks
    const { data: cached, error } = await supabase
      .from("order_candlesticks")
      .select("ticker, min_price_cents, result_status");

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

    const totalWins = validData.length;

    // Build threshold summary for every 5¢ from 5 to 95
    const thresholds: { low: number; count: number; pct: string }[] = [];
    
    for (let threshold = 5; threshold <= 95; threshold += 5) {
      const count = validData.filter(c => c.min_price_cents <= threshold).length;
      thresholds.push({
        low: threshold,
        count,
        pct: totalWins > 0 ? ((count / totalWins) * 100).toFixed(1) : "0",
      });
    }

    return NextResponse.json({
      success: true,
      total_wins: totalWins,
      thresholds,
    });
  } catch (e) {
    console.error("[Candlestick Analysis] Error:", e);
    return NextResponse.json({
      success: false,
      error: e instanceof Error ? e.message : "Unknown error",
    });
  }
}
