import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST - Toggle pause for today's or tomorrow's batch
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { batch_id, is_paused } = body;

    if (!batch_id) {
      // If no batch_id, toggle today's batch
      const today = new Date().toISOString().split('T')[0];
      
      const { data: batch, error: fetchError } = await supabase
        .from('order_batches')
        .select('*')
        .eq('batch_date', today)
        .single();

      if (fetchError || !batch) {
        return NextResponse.json({
          success: false,
          error: `No batch found for today (${today})`,
        }, { status: 404 });
      }

      const newPausedState = is_paused !== undefined ? is_paused : !batch.is_paused;

      const { error } = await supabase
        .from('order_batches')
        .update({ is_paused: newPausedState })
        .eq('id', batch.id);

      if (error) throw error;

      return NextResponse.json({
        success: true,
        batch_id: batch.id,
        is_paused: newPausedState,
      });
    }

    // Toggle specific batch
    const { data: batch, error: fetchError } = await supabase
      .from('order_batches')
      .select('*')
      .eq('id', batch_id)
      .single();

    if (fetchError || !batch) {
      return NextResponse.json({
        success: false,
        error: 'Batch not found',
      }, { status: 404 });
    }

    const newPausedState = is_paused !== undefined ? is_paused : !batch.is_paused;

    const { error } = await supabase
      .from('order_batches')
      .update({ is_paused: newPausedState })
      .eq('id', batch_id);

    if (error) throw error;

    return NextResponse.json({
      success: true,
      batch_id: batch_id,
      is_paused: newPausedState,
    });
  } catch (error) {
    console.error('Error toggling pause:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

