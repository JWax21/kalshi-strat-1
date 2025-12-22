import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST - Verify credentials
export async function POST(request: Request) {
  try {
    const { username, pin } = await request.json();

    if (!username || !pin) {
      return NextResponse.json({ success: false, error: 'Username and PIN required' }, { status: 400 });
    }

    // Check credentials against Supabase table
    const { data, error } = await supabase
      .from('auth_users')
      .select('id, username')
      .eq('username', username.toLowerCase().trim())
      .eq('pin', pin)
      .single();

    if (error || !data) {
      return NextResponse.json({ success: false, error: 'Invalid credentials' }, { status: 401 });
    }

    return NextResponse.json({ 
      success: true, 
      user: { id: data.id, username: data.username } 
    });
  } catch (error) {
    console.error('Auth error:', error);
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    );
  }
}

