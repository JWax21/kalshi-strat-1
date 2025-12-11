import { NextResponse } from 'next/server';
import { placeOrder, getPositions, getBalance, KalshiOrder } from '@/lib/kalshi';
import { v4 as uuidv4 } from 'uuid';

// Force Node.js runtime for crypto module
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    
    const { ticker, action, side, count, type, yes_price } = body;
    
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
    
    // For limit orders, validate price
    if (type === 'limit' && (yes_price < 1 || yes_price > 99)) {
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
    
    if (type === 'limit' && yes_price) {
      order.yes_price = parseInt(yes_price);
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

