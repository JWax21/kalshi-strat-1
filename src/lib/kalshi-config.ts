// Kalshi API Configuration
// Set these environment variables in Vercel or .env.local

export const KALSHI_CONFIG = {
  apiKey: process.env.KALSHI_API_KEY || '',
  privateKey: (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  baseUrl: 'https://api.elections.kalshi.com/trade-api/v2',
};
