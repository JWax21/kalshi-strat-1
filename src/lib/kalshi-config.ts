// Kalshi API Configuration
// Set these environment variables in Vercel or .env.local

// Handle private key newlines - Vercel may store them as literal \n or actual newlines
function parsePrivateKey(key: string | undefined): string {
  if (!key) return '';
  
  // First, replace literal \n with actual newlines
  let parsed = key.replace(/\\n/g, '\n');
  
  // If still no newlines and it's a single line, try to reconstruct PEM format
  if (!parsed.includes('\n') && parsed.includes('-----BEGIN')) {
    // Extract the base64 content between headers
    const match = parsed.match(/-----BEGIN[^-]+-----(.+)-----END[^-]+-----/);
    if (match) {
      const header = parsed.match(/-----BEGIN[^-]+-----/)?.[0] || '';
      const footer = parsed.match(/-----END[^-]+-----/)?.[0] || '';
      const base64Content = match[1];
      // Split into 64-char lines
      const lines = base64Content.match(/.{1,64}/g) || [];
      parsed = [header, ...lines, footer].join('\n');
    }
  }
  
  return parsed;
}

export const KALSHI_CONFIG = {
  apiKey: process.env.KALSHI_API_KEY || '',
  privateKey: parsePrivateKey(process.env.KALSHI_PRIVATE_KEY),
  baseUrl: 'https://api.elections.kalshi.com/trade-api/v2',
};
