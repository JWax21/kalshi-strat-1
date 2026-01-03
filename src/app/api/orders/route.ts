import { NextResponse } from 'next/server';
import { placeOrder, getPositions, getBalance, KalshiOrder } from '@/lib/kalshi';
import { supabase } from '@/lib/supabase';
import { v4 as uuidv4 } from 'uuid';

// Force Node.js runtime for crypto module
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_POSITION_PERCENT = 0.03; // 3% max per market - UNBREAKABLE
const MIN_PRICE_CENTS = 90; // UNBREAKABLE: NEVER bet on favorites below 90 cents

// GET - Fetch positions and balance
export async function GET() {
  try {
    const [positions, balance] = await Promise.all([
      getPositions(),
      getBalance(),
    ]);
    
    return NextResponse.json({
      success: true,
      positions,
      balance,
    });
  } catch (error) {
    console.error('Error fetching portfolio:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// POST - Place an order
export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    const { ticker, action, side, count, type, yes_price, no_price } = body;
    
    // Validate required fields
    if (!ticker || !action || !side || !count || !type) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: ticker, action, side, count, type' },
        { status: 400 }
      );
    }
    
    // Validate action
    if (!['buy', 'sell'].includes(action)) {
      return NextResponse.json(
        { success: false, error: 'Action must be "buy" or "sell"' },
        { status: 400 }
      );
    }
    
    // Validate side
    if (!['yes', 'no'].includes(side)) {
      return NextResponse.json(
        { success: false, error: 'Side must be "yes" or "no"' },
        { status: 400 }
      );
    }
    
    // Validate type
    if (!['limit', 'market'].includes(type)) {
      return NextResponse.json(
        { success: false, error: 'Type must be "limit" or "market"' },
        { status: 400 }
      );
    }
    
    // Validate count
    if (count < 1) {
      return NextResponse.json(
        { success: false, error: 'Count must be at least 1' },
        { status: 400 }
      );
    }
    
    // For limit orders, validate price (must have exactly one of yes_price or no_price)
    const price = yes_price || no_price;
    if (type === 'limit' && (!price || price < 1 || price > 99)) {
      return NextResponse.json(
        { success: false, error: 'Price must be between 1 and 99 cents' },
        { status: 400 }
      );
    }
    
    const order: KalshiOrder = {
      ticker,
      action,
      side,
      count: parseInt(count),
      type,
      client_order_id: uuidv4(),
    };
    
    // Add the appropriate price based on side
    if (yes_price) {
      order.yes_price = parseInt(yes_price);
    }
    if (no_price) {
      order.no_price = parseInt(no_price);
    }
    
    // ========================================
    // GUARDS: NEVER exceed 3% of portfolio, NEVER bet below 90 cents (BUY orders only)
    // These are UNBREAKABLE barriers - final safety check before placing
    // ========================================
    if (action === 'buy') {
      const priceCents = yes_price ? parseInt(yes_price) : no_price ? parseInt(no_price) : 0;
      
      // MIN PRICE GUARD
      if (priceCents < MIN_PRICE_CENTS) {
        const errorMsg = `MIN PRICE BLOCKED: Price ${priceCents}¢ below minimum ${MIN_PRICE_CENTS}¢ - cannot bet on favorites below 90%`;
        console.error(errorMsg);
        return NextResponse.json(
          { success: false, error: errorMsg },
          { status: 400 }
        );
      }
      
      // Get portfolio_value directly from Kalshi
      // CRITICAL: Total portfolio = balance (cash) + portfolio_value (positions value)
      let totalPortfolioCents = 0;
      
      try {
        const balanceData = await getBalance();
        const cashBalance = balanceData.balance || 0;
        const positionsValue = balanceData.portfolio_value || 0;
        // Total portfolio = cash + positions value (Kalshi returns these separately)
        totalPortfolioCents = cashBalance + positionsValue;
        console.log(`Kalshi balance: cash=${cashBalance}¢, positions=${positionsValue}¢, total=${totalPortfolioCents}¢`);
      } catch (e) {
        console.error('Error fetching portfolio for hard cap check:', e);
        return NextResponse.json(
          { success: false, error: 'Could not fetch portfolio value from Kalshi' },
          { status: 500 }
        );
      }
      
      const hardCapCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
      const orderCostCents = priceCents * parseInt(count);
      
      // CRITICAL: Check EXISTING exposure on this ticker
      // Must check TOTAL (existing + new), not just new order
      let existingExposureCents = 0;
      try {
        const positionsData = await getPositions();
        const position = (positionsData.market_positions || []).find((p: any) => p.ticker === ticker);
        if (position) {
          existingExposureCents = position.market_exposure || 0;
        }
      } catch (e) {
        console.error('Error fetching existing position:', e);
        // Continue with 0 exposure - be conservative
      }
      
      const totalPositionCost = existingExposureCents + orderCostCents;
      
      // HARD CAP GUARD - check TOTAL exposure (existing + new)
      if (totalPositionCost > hardCapCents) {
        const errorMsg = `HARD CAP BLOCKED: Total position ${totalPositionCost}¢ (existing ${existingExposureCents}¢ + new ${orderCostCents}¢) exceeds 3% cap (${hardCapCents}¢). Portfolio: $${(totalPortfolioCents/100).toFixed(2)}`;
        console.error(errorMsg);
        return NextResponse.json(
          { success: false, error: errorMsg },
          { status: 400 }
        );
      }
      
      // ========================================
      // EVENT-LEVEL CAP GUARD: NEVER exceed 3% on any single EVENT
      // This prevents betting on both sides of the same game
      // Extract event_ticker from ticker (format: KXNBAGAME-25JAN03-DALCHI-M1 -> KXNBAGAME-25JAN03-DALCHI)
      // ========================================
      const tickerParts = ticker.split('-');
      // Remove the last part (market identifier like M1, SPREAD, etc.)
      const eventTicker = tickerParts.length > 2 ? tickerParts.slice(0, -1).join('-') : ticker;
      
      // Get event-level exposure from database
      let eventExposureCents = 0;
      try {
        const { data: eventOrders } = await supabase
          .from('orders')
          .select('cost_cents, executed_cost_cents')
          .eq('event_ticker', eventTicker)
          .in('placement_status', ['placed', 'confirmed']);
        
        for (const order of eventOrders || []) {
          eventExposureCents += order.executed_cost_cents || order.cost_cents || 0;
        }
      } catch (e) {
        console.error('Error fetching event exposure:', e);
        // Continue with 0 exposure
      }
      
      const totalEventExposure = eventExposureCents + orderCostCents;
      
      if (totalEventExposure > hardCapCents) {
        const errorMsg = `EVENT CAP BLOCKED: Event ${eventTicker} total ${totalEventExposure}¢ (existing ${eventExposureCents}¢ + new ${orderCostCents}¢) exceeds 3% cap (${hardCapCents}¢). Portfolio: $${(totalPortfolioCents/100).toFixed(2)}`;
        console.error(errorMsg);
        return NextResponse.json(
          { success: false, error: errorMsg },
          { status: 400 }
        );
      }
      
      console.log(`Guards passed: price=${priceCents}¢ >= 90¢, total position=${totalPositionCost}¢ (existing ${existingExposureCents}¢ + new ${orderCostCents}¢) <= ${hardCapCents}¢ (3% of ${totalPortfolioCents}¢)`);
    }
    
    console.log('Placing order:', order);
    
    const result = await placeOrder(order);
    
    return NextResponse.json({
      success: true,
      order: result.order,
      client_order_id: order.client_order_id,
    });
  } catch (error) {
    console.error('Error placing order:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

