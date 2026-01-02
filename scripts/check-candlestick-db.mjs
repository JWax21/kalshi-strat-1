import { createClient } from "@supabase/supabase-js";

const supabaseUrl = 'https://lnycekbczyhxjlxoooqn.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxueWNla2JjenloeGpseG9vb3FuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTQ5ODEzMywiZXhwIjoyMDgxMDc0MTMzfQ.yXwhA29D_yVlWDU6UQDCOY5AAp-ZaddNe3A39fQWNNI';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  console.log("=== Checking order_candlesticks table ===\n");

  // Count total
  const { count } = await supabase
    .from("order_candlesticks")
    .select("*", { count: "exact", head: true });
  console.log("Total rows:", count);

  // Get first 5 rows
  const { data: sample, error } = await supabase
    .from("order_candlesticks")
    .select("ticker, min_price_cents, result_status, entry_price_cents, side")
    .limit(5);

  console.log("\nSample rows:");
  console.log("Error:", error);
  if (sample) {
    sample.forEach(r => console.log(JSON.stringify(r)));
  }

  // Count with filters
  const { data: wonWithMin } = await supabase
    .from("order_candlesticks")
    .select("*")
    .eq("result_status", "won")
    .not("min_price_cents", "is", null);
  console.log("\nRows with result_status=won AND min_price_cents not null:", wonWithMin?.length);

  // Show min_price_cents distribution
  if (wonWithMin && wonWithMin.length > 0) {
    const counts = { below50: 0, below60: 0, below70: 0, below80: 0, above80: 0 };
    wonWithMin.forEach(r => {
      const mp = r.min_price_cents || 100;
      if (mp <= 50) counts.below50++;
      else if (mp <= 60) counts.below60++;
      else if (mp <= 70) counts.below70++;
      else if (mp <= 80) counts.below80++;
      else counts.above80++;
    });
    console.log("\nDistribution of min_price_cents:");
    console.log("  ≤50:", counts.below50);
    console.log("  51-60:", counts.below60);
    console.log("  61-70:", counts.below70);
    console.log("  71-80:", counts.below80);
    console.log("  >80:", counts.above80);

    // Show first 5 low ones
    console.log("\nFirst 5 with lowest min_price_cents:");
    const sorted = wonWithMin.sort((a,b) => (a.min_price_cents || 100) - (b.min_price_cents || 100));
    sorted.slice(0, 5).forEach(r => {
      console.log(`  ${r.ticker}: min=${r.min_price_cents}, entry=${r.entry_price_cents}`);
    });
  }
}

main().catch(console.error);
