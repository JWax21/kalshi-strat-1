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
      // CRITICAL: Use portfolio_value from Kalshi (not manual calculation) for 3% limit
      let totalPortfolioCents = 0;
      
      try {
        const balanceData = await getBalance();
        // portfolio_value = cash + all positions (from Kalshi directly - the source of truth)
        totalPortfolioCents = balanceData.portfolio_value || balanceData.balance || 0;
        console.log(`Kalshi portfolio_value: ${totalPortfolioCents}¢`);
      } catch (e) {
        console.error('Error fetching portfolio for hard cap check:', e);
        return NextResponse.json(
          { success: false, error: 'Could not fetch portfolio value from Kalshi' },
          { status: 500 }
        );
      }
      
      const hardCapCents = Math.floor(totalPortfolioCents * MAX_POSITION_PERCENT);
      const orderCostCents = priceCents * parseInt(count);
      
      // HARD CAP GUARD
      if (orderCostCents > hardCapCents) {
        const errorMsg = `HARD CAP BLOCKED: Order cost ${orderCostCents}¢ ($${(orderCostCents/100).toFixed(2)}) exceeds 3% of portfolio (${hardCapCents}¢ / $${(hardCapCents/100).toFixed(2)}). Portfolio: $${(totalPortfolioCents/100).toFixed(2)} (from Kalshi)`;
        console.error(errorMsg);
        return NextResponse.json(
          { success: false, error: errorMsg },
          { status: 400 }
        );
      }
      
      console.log(`Guards passed: price=${priceCents}¢ >= 90¢, cost=${orderCostCents}¢ <= ${hardCapCents}¢ (3% of ${totalPortfolioCents}¢ from Kalshi)`);
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

