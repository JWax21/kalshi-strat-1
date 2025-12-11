import { NextResponse } from 'next/server';
import { getOrderbook } from '@/lib/kalshi';

// Force Node.js runtime for crypto module
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: { ticker: string } }
) {
  try {
    const { ticker } = params;
    const { searchParams } = new URL(request.url);
    const depth = parseInt(searchParams.get('depth') || '0');

    if (!ticker) {
      return NextResponse.json(
        { success: false, error: 'Ticker is required' },
        { status: 400 }
      );
    }

    const orderbook = await getOrderbook(ticker, depth);

    return NextResponse.json({
      success: true,
      ticker,
      orderbook,
    });
  } catch (error) {
    console.error('Error fetching orderbook:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

