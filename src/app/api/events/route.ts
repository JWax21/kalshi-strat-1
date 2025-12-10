import { NextResponse } from 'next/server';
import { getEvents } from '@/lib/kalshi';

// Force Node.js runtime for crypto module
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '200');
    const category = searchParams.get('category') || undefined;
    const events = await getEvents(limit, category);
    return NextResponse.json({ success: true, count: events.length, events });
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

