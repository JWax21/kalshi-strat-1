import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import crypto from "crypto";
import { KALSHI_CONFIG } from "@/lib/kalshi-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rate limit: max 10 requests per second to be safe
const RATE_LIMIT_DELAY_MS = 100;
const HOT_THRESHOLD_CENTS = 51; // Orders are "hot" when current odds > 51%

interface HotBet {
  id: string;
  ticker: string;
  event_ticker: string;
  title: string;
  side: string;
  units: number;
  avg_price_cents: number;
  current_odds_cents: number;
  cost_cents: number;
  potential_payout_cents: number;
  potential_profit_cents: number;
  batch_date: string;
}

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
    throw new Error(`Kalshi API error: ${response.status}`);
  }

  return response.json();
}

export async function GET() {
  try {
    // Get all active (undecided) orders
    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select(`
        id,
        ticker,
        event_ticker,
        title,
        side,
        units,
        price_cents,
        executed_price_cents,
        cost_cents,
        executed_cost_cents,
        potential_payout_cents,
        placement_status,
        result_status,
        batch_id
      `)
      .eq("placement_status", "confirmed")
      .eq("result_status", "undecided");

    if (ordersError) throw ordersError;

    const activeOrders = orders || [];
    
    if (activeOrders.length === 0) {
      return NextResponse.json({
        success: true,
        hot_bets: [],
        total_checked: 0,
        errors: [],
      });
    }

    // Get batch dates for context
    const batchIds = [...new Set(activeOrders.map(o => o.batch_id))];
    const { data: batches } = await supabase
      .from("order_batches")
      .select("id, batch_date")
      .in("id", batchIds);
    
    const batchDateMap = new Map((batches || []).map(b => [b.id, b.batch_date]));

    // Fetch current odds for each unique ticker
    const uniqueTickers = [...new Set(activeOrders.map(o => o.ticker))];
    const currentOdds: Record<string, { yes: number; no: number }> = {};
    const errors: string[] = [];

    console.log(`Fetching odds for ${uniqueTickers.length} markets...`);

    for (const ticker of uniqueTickers) {
      try {
        const marketData = await kalshiFetch(`/markets/${ticker}`);
        if (marketData?.market) {
          const yesBid = marketData.market.yes_bid || 0;
          const yesAsk = marketData.market.yes_ask || 0;
          const noBid = marketData.market.no_bid || 0;
          const noAsk = marketData.market.no_ask || 0;
          
          // Use midpoint for more accurate pricing
          const yesPrice = Math.round((yesBid + yesAsk) / 2) || marketData.market.last_price || 0;
          const noPrice = Math.round((noBid + noAsk) / 2) || (100 - yesPrice);
          
          currentOdds[ticker] = { yes: yesPrice, no: noPrice };
        }
      } catch (e) {
        errors.push(`Error fetching ${ticker}: ${e}`);
      }
      
      // Rate limit delay
      await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }

    console.log(`Fetched odds for ${Object.keys(currentOdds).length} markets`);

    // Find HOT bets (current odds > threshold)
    const hotBets: HotBet[] = [];
    
    for (const order of activeOrders) {
      const odds = currentOdds[order.ticker];
      if (!odds) continue;
      
      // Get current odds for our side
      const currentOddsCents = order.side === "YES" ? odds.yes : odds.no;
      
      // Only include if above HOT threshold
      if (currentOddsCents > HOT_THRESHOLD_CENTS) {
        const avgPrice = order.executed_price_cents || order.price_cents || 0;
        const cost = order.executed_cost_cents || order.cost_cents || 0;
        const payout = order.potential_payout_cents || (order.units * 100);
        
        hotBets.push({
          id: order.id,
          ticker: order.ticker,
          event_ticker: order.event_ticker,
          title: order.title,
          side: order.side,
          units: order.units,
          avg_price_cents: avgPrice,
          current_odds_cents: currentOddsCents,
          cost_cents: cost,
          potential_payout_cents: payout,
          potential_profit_cents: payout - cost,
          batch_date: batchDateMap.get(order.batch_id) || "Unknown",
        });
      }
    }

    // Sort by current odds (highest first)
    hotBets.sort((a, b) => b.current_odds_cents - a.current_odds_cents);

    return NextResponse.json({
      success: true,
      hot_bets: hotBets,
      total_checked: activeOrders.length,
      total_hot: hotBets.length,
      threshold: HOT_THRESHOLD_CENTS,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error fetching hot bets:", error);
    return NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 }
    );
  }
}

