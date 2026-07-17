const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// General limiter: max 100 requests per 15 minutes per IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limiter for sensitive admin endpoints: max 10 requests per hour per IP
const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many admin requests. Please try again after an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);
// ─────────────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

console.log('DATABASE_URL present:', !!process.env.DATABASE_URL);
console.log('ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY);

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      bank TEXT NOT NULL,
      card TEXT NOT NULL,
      variant TEXT NOT NULL,
      platform TEXT NOT NULL,
      value TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      cap TEXT,
      validity TEXT,
      min_spend INTEGER DEFAULT 0,
      source_url TEXT,
      status TEXT DEFAULT 'active',
      best BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      bank TEXT NOT NULL,
      card_type TEXT NOT NULL,
      variant TEXT NOT NULL,
      synced_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, bank, card_type, variant)
    );
    CREATE TABLE IF NOT EXISTS savings_log (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      offer_id TEXT,
      title TEXT,
      bank TEXT,
      amount INTEGER NOT NULL,
      date TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS community_submissions (
      id SERIAL PRIMARY KEY,
      bank TEXT NOT NULL,
      card TEXT NOT NULL,
      variant TEXT NOT NULL,
      platform TEXT NOT NULL,
      value TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      cap TEXT,
      validity TEXT,
      submitted_by TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bank_sources (
      id SERIAL PRIMARY KEY,
      bank TEXT NOT NULL,
      platform TEXT NOT NULL,
      url TEXT NOT NULL,
      last_crawled TIMESTAMP,
      active BOOLEAN DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS offer_reports (
      id SERIAL PRIMARY KEY,
      offer_id TEXT NOT NULL,
      offer_title TEXT,
      bank TEXT,
      platform TEXT,
      reason TEXT NOT NULL,
      reported_by TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_backups (
      id SERIAL PRIMARY KEY,
      backup_code TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      last_used TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS push_tokens (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Seed default bank sources if table is empty
  const sourceCount = await pool.query('SELECT COUNT(*) FROM bank_sources');
  if (parseInt(sourceCount.rows[0].count) === 0) {
    const defaultSources = [
      // HDFC
      { bank: 'HDFC',   platform: 'amazon',      url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/credit-card-offers' },
      { bank: 'HDFC',   platform: 'flipkart',    url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/credit-card-offers' },
      { bank: 'HDFC',   platform: 'swiggy',      url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/credit-card-offers' },
      { bank: 'HDFC',   platform: 'zomato',      url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/credit-card-offers' },
      { bank: 'HDFC',   platform: 'myntra',      url: 'https://www.hdfcbank.com/personal/pay/cards/credit-cards/credit-card-offers' },
      // Axis
      { bank: 'Axis',   platform: 'amazon',      url: 'https://www.axisbank.com/retail/offers/shopping/amazon-offers' },
      { bank: 'Axis',   platform: 'flipkart',    url: 'https://www.axisbank.com/retail/offers/shopping/flipkart-offers' },
      { bank: 'Axis',   platform: 'swiggy',      url: 'https://www.axisbank.com/retail/offers/food-and-dining/swiggy-offers' },
      { bank: 'Axis',   platform: 'zomato',      url: 'https://www.axisbank.com/retail/offers/food-and-dining/zomato-offers' },
      { bank: 'Axis',   platform: 'iocl',        url: 'https://www.axisbank.com/retail/offers/petrol-pump-offers' },
      // ICICI
      { bank: 'ICICI',  platform: 'amazon',      url: 'https://www.icicibank.com/offers/online-shopping/amazon' },
      { bank: 'ICICI',  platform: 'flipkart',    url: 'https://www.icicibank.com/offers/online-shopping/flipkart' },
      { bank: 'ICICI',  platform: 'swiggy',      url: 'https://www.icicibank.com/offers/food/swiggy' },
      { bank: 'ICICI',  platform: 'zomato',      url: 'https://www.icicibank.com/offers/food/zomato' },
      { bank: 'ICICI',  platform: 'makemytrip',  url: 'https://www.icicibank.com/offers/travel/makemytrip' },
      // SBI
      { bank: 'SBI',    platform: 'amazon',      url: 'https://www.sbicard.com/en/personal/offers/shopping/amazon-great-offers.page' },
      { bank: 'SBI',    platform: 'flipkart',    url: 'https://www.sbicard.com/en/personal/offers/shopping/flipkart-offers.page' },
      { bank: 'SBI',    platform: 'irctc',       url: 'https://www.sbicard.com/en/personal/offers/travel/irctc-offers.page' },
      { bank: 'SBI',    platform: 'swiggy',      url: 'https://www.sbicard.com/en/personal/offers/food-and-dining/swiggy.page' },
      // Kotak
      { bank: 'Kotak',  platform: 'amazon',      url: 'https://www.kotak.com/en/offers/online-shopping/amazon.html' },
      { bank: 'Kotak',  platform: 'swiggy',      url: 'https://www.kotak.com/en/offers/food-and-dining/swiggy.html' },
      { bank: 'Kotak',  platform: 'zomato',      url: 'https://www.kotak.com/en/offers/food-and-dining/zomato.html' },
      // IDFC
      { bank: 'IDFC',   platform: 'swiggy',      url: 'https://www.idfcfirstbank.com/offers/food-and-dining/swiggy' },
      { bank: 'IDFC',   platform: 'amazon',      url: 'https://www.idfcfirstbank.com/offers/shopping/amazon' },
      { bank: 'IDFC',   platform: 'flipkart',    url: 'https://www.idfcfirstbank.com/offers/shopping/flipkart' },
      // IndusInd
      { bank: 'IndusInd', platform: 'amazon',    url: 'https://www.indusind.com/iblogs/credit-cards/credit-card-offers/' },
      { bank: 'IndusInd', platform: 'swiggy',    url: 'https://www.indusind.com/iblogs/credit-cards/credit-card-offers/' },
      // HSBC
      { bank: 'HSBC',   platform: 'amazon',      url: 'https://www.hsbc.co.in/credit-cards/offers/' },
      { bank: 'HSBC',   platform: 'flipkart',    url: 'https://www.hsbc.co.in/credit-cards/offers/' },
      // Yes Bank
      { bank: 'Yes Bank', platform: 'amazon',    url: 'https://www.yesbank.in/personal-banking/yes-preferred/cards/credit-card/offers' },
    ];
    for (const s of defaultSources) {
      await pool.query(
        'INSERT INTO bank_sources (bank, platform, url) VALUES ($1, $2, $3)',
        [s.bank, s.platform, s.url]
      );
    }
    console.log(`[Bank Sources] Seeded ${defaultSources.length} default sources.`);
  }

  console.log('Database tables ready');
}

app.get('/', (req, res) => {
  res.json({ status: 'CardOffers API is running!' });
});

app.get('/offers', async (req, res) => {
  try {
    // Only return offers that have not yet expired
    // validity is stored as "DD Mon YYYY" e.g. "30 Jun 2026"
    // We parse it in JS and filter out anything where today > validity date
    const result = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
    const today = new Date();
    today.setHours(0, 0, 0, 0); // compare by date only, ignore time

    const months = {
      Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
      Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11
    };

    const activeOffers = result.rows.filter(o => {
      // Fix 6: respect status field
      if (o.status === 'expired' || o.status === 'deleted') return false;
      try {
        const parts = (o.validity || '').trim().split(' ');
        if (parts.length < 3) return true;
        const expiry = new Date(parseInt(parts[2]), months[parts[1]], parseInt(parts[0]));
        return expiry >= today;
      } catch (e) {
        return true;
      }
    });

    res.json(activeOffers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/offers', async (req, res) => {
  const { id, bank, card, variant, platform, value, type, title, description, cap, validity, best, min_spend, source_url } = req.body;
  try {
    await pool.query(
      `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best, min_spend)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET bank=$2, card=$3, variant=$4, platform=$5, value=$6, type=$7, title=$8, description=$9, cap=$10, validity=$11, best=$12, min_spend=$13`,
      [id, bank, card, variant, platform, value, type, title, description, cap, validity, best, min_spend||0]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/offers/bulk', async (req, res) => {
  const { offers } = req.body;
  if (!offers || !Array.isArray(offers)) return res.status(400).json({ error: 'Please provide an array of offers.' });
  try {
    let saved = 0;
    let skipped = 0;
    for (const o of offers) {
      // Check if similar offer already exists
      const existing = await pool.query(
        `SELECT id FROM offers 
         WHERE bank=$1 AND platform=$2 AND value=$3 AND card=$4`,
        [o.bank, o.platform, o.value, o.card]
      );
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }
      await pool.query(
        `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET bank=$2, card=$3, variant=$4, platform=$5, value=$6, type=$7, title=$8, description=$9, cap=$10, validity=$11, best=$12`,
        [o.id, o.bank, o.card, o.variant||'All', o.platform, o.value, o.type, o.title, o.description||'', o.cap||'No cap', o.validity, o.best||false]
      );
      saved++;
    }
    res.json({ success: true, saved, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/offers/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM offers WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/wallet/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM wallets WHERE user_id=$1 ORDER BY created_at ASC', [req.params.userId]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/wallet', async (req, res) => {
  const { user_id, bank, card_type, variant } = req.body;
  try {
    await pool.query(
      `INSERT INTO wallets (user_id, bank, card_type, variant) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, bank, card_type, variant) DO NOTHING`,
      [user_id, bank, card_type, variant]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/wallet/:userId/:bank/:cardType/:variant', async (req, res) => {
  const { userId, bank, cardType, variant } = req.params;
  try {
    await pool.query('DELETE FROM wallets WHERE user_id=$1 AND bank=$2 AND card_type=$3 AND variant=$4', [userId, bank, cardType, variant]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/savings/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM savings_log WHERE user_id=$1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/savings', async (req, res) => {
  const { user_id, offer_id, title, bank, amount, date } = req.body;
  try {
    await pool.query(`INSERT INTO savings_log (user_id, offer_id, title, bank, amount, date) VALUES ($1,$2,$3,$4,$5,$6)`, [user_id, offer_id, title, bank, amount, date]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Fix 1: Report incorrect offer ───────────────────────────────────────────
app.post('/report-offer', async (req, res) => {
  const { offer_id, offer_title, bank, platform, reason, reported_by } = req.body;
  if (!offer_id || !reason) return res.status(400).json({ error: 'offer_id and reason are required' });
  try {
    await pool.query(
      `INSERT INTO offer_reports (offer_id, offer_title, bank, platform, reason, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [offer_id, offer_title||'', bank||'', platform||'', reason, reported_by||'anonymous']
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/reports', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM offer_reports WHERE status='pending' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/reports/:id/resolve', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    await pool.query("UPDATE offer_reports SET status='resolved' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/reports/:id/delete-offer', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const rpt = await pool.query('SELECT * FROM offer_reports WHERE id=$1', [req.params.id]);
    if (!rpt.rows.length) return res.status(404).json({ error: 'Report not found' });
    await pool.query('DELETE FROM offers WHERE id=$1', [rpt.rows[0].offer_id]);
    await pool.query("UPDATE offer_reports SET status='resolved' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── Fix 3: Backup code for wallet restore ────────────────────────────────────
app.post('/backup/create', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  try {
    // Generate a readable 8-character alphanumeric code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];

    await pool.query(
      `INSERT INTO user_backups (backup_code, user_id)
       VALUES ($1, $2)
       ON CONFLICT (backup_code) DO UPDATE SET user_id=$2, last_used=NOW()`,
      [code, user_id]
    );
    res.json({ success: true, backup_code: code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/backup/restore', async (req, res) => {
  const { backup_code } = req.body;
  if (!backup_code) return res.status(400).json({ error: 'backup_code required' });
  try {
    const result = await pool.query(
      'SELECT * FROM user_backups WHERE backup_code=$1',
      [backup_code.toUpperCase().trim()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Invalid backup code. Please check and try again.' });

    const original_user_id = result.rows[0].user_id;
    await pool.query('UPDATE user_backups SET last_used=NOW() WHERE backup_code=$1', [backup_code]);

    const wallet = await pool.query('SELECT * FROM wallets WHERE user_id=$1', [original_user_id]);
    const savings = await pool.query('SELECT * FROM savings_log WHERE user_id=$1 ORDER BY created_at DESC', [original_user_id]);

    res.json({
      success: true,
      original_user_id,
      wallet: wallet.rows,
      savings: savings.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── Fix 7: Push notification token registration ──────────────────────────────
app.post('/push-token', async (req, res) => {
  const { user_id, token } = req.body;
  if (!user_id || !token) return res.status(400).json({ error: 'user_id and token required' });
  try {
    await pool.query(
      `INSERT INTO push_tokens (user_id, token) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET token=$2`,
      [user_id, token]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send weekly digest push notification (called by scheduler)
async function sendWeeklyPushDigest() {
  try {
    const tokens = await pool.query('SELECT * FROM push_tokens');
    if (!tokens.rows.length) return;

    const offerCount = await pool.query('SELECT COUNT(*) FROM offers');
    const count = parseInt(offerCount.rows[0].count);

    const messages = tokens.rows.map(t => ({
      to: t.token,
      sound: 'default',
      title: 'PickAPay — Weekly Update 🎉',
      body: `${count} active offers available for your cards. Check what's new!`,
      data: { screen: 'platforms' },
    }));

    // Send in batches of 100 (Expo limit)
    for (let i = 0; i < messages.length; i += 100) {
      const batch = messages.slice(i, i + 100);
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(batch),
      });
    }
    console.log(`[Push] Weekly digest sent to ${tokens.rows.length} devices`);
  } catch (e) {
    console.error('[Push] Failed to send weekly digest:', e.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

app.get('/submissions', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM community_submissions WHERE status='pending' ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/submissions', async (req, res) => {
  const { bank, card, variant, platform, value, type, title, description, cap, validity, submitted_by } = req.body;
  try {
    // Fix 13: Rate limit — max 3 submissions per user per day
    if (submitted_by && submitted_by !== 'anonymous') {
      const today = new Date(); today.setHours(0,0,0,0);
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM community_submissions WHERE submitted_by=$1 AND created_at >= $2`,
        [submitted_by, today]
      );
      if (parseInt(countResult.rows[0].count) >= 3) {
        return res.status(429).json({ error: 'You can submit a maximum of 3 offers per day. Thank you for contributing!' });
      }
    }
    await pool.query(
      `INSERT INTO community_submissions (bank, card, variant, platform, value, type, title, description, cap, validity, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [bank, card, variant||'All', platform, value, type, title, description||'', cap||'No cap', validity, submitted_by||'anonymous']
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/submissions/:id/approve', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const sub = await pool.query('SELECT * FROM community_submissions WHERE id=$1', [req.params.id]);
    if (!sub.rows.length) return res.status(404).json({ error: 'Submission not found' });
    const o = sub.rows[0];
    const newId = `comm_${o.bank.toLowerCase()}_${Date.now()}`;
    await pool.query(
      `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [newId, o.bank, o.card, o.variant, o.platform, o.value, o.type, o.title, o.description, o.cap, o.validity, false]
    );
    await pool.query("UPDATE community_submissions SET status='approved' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/submissions/:id/reject', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    await pool.query("UPDATE community_submissions SET status='rejected' WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/extract-offers', async (req, res) => {
  const { text, bank } = req.body;
  if (!text || !bank) return res.status(400).json({ error: 'Please provide both text and bank name.' });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Remove HTML tags and trim to avoid token limit
    let cleanText = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanText.length > 12000) {
      cleanText = cleanText.substring(0, 12000);
    }

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a helpful assistant that extracts credit card offers from bank website text.

Extract all credit card offers from the following text from ${bank} bank website.
Return ONLY a valid JSON array with no extra text, no markdown, no explanation.

Each offer must have exactly these fields:
- bank: "${bank}"
- card: "Credit" or "Debit"
- variant: the specific card variant name or "All" if applies to all cards
- platform: one of: amazon, flipkart, swiggy, zomato, myntra, ajio, bigbasket, blinkit, nykaa, makemytrip, irctc, bookmyshow
- value: the discount amount like "10%" or "100" or "5x"
- type: "cashback" or "flat" or "points"
- title: short title of the offer (max 60 chars)
- description: brief description (max 120 chars)
- cap: maximum discount cap like "Max 500" or "No cap"
- validity: expiry date in format "DD Mon YYYY" like "30 Jun 2026"
- best: true if this is an exceptional deal, false otherwise

Only include offers for these platforms: amazon, flipkart, swiggy, zomato, myntra, ajio, bigbasket, blinkit, nykaa, makemytrip, irctc, bookmyshow.
Skip any offers for other platforms.
If validity date is not mentioned, use "30 Jun 2026".
If card variant is not mentioned, use "All".

Here is the bank website text:
${cleanText}

Return only the JSON array, nothing else.`
      }]
    });

    const responseText = message.content[0].text.trim();
    const cleaned = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

    let extractedOffers;
    try {
      extractedOffers = JSON.parse(cleaned);
    } catch (parseError) {
      return res.status(500).json({ error: 'Could not parse AI response. Please try again.', raw: responseText });
    }

    const offersWithIds = extractedOffers.map((offer, index) => ({
      id: `ai_${bank.toLowerCase().replace(/\s/g,'_')}_${Date.now()}_${index}`,
      ...offer
    }));

    res.json({ success: true, count: offersWithIds.length, offers: offersWithIds });

  } catch (error) {
    console.error('AI extraction error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Step 3: Crawler function (Perplexity-powered) ──────────────────────────
async function crawlAndUpdateOffers() {
  console.log('[Auto-update] Starting Perplexity-powered offer crawl...');
  console.log('[Auto-update] PERPLEXITY_API_KEY present:', !!process.env.PERPLEXITY_API_KEY);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const perplexityKey = process.env.PERPLEXITY_API_KEY;

  if (!perplexityKey) {
    console.error('[Auto-update] PERPLEXITY_API_KEY not set — aborting crawl.');
    return 0;
  }

  // All bank + platform combinations to search
  const searchTargets = [
    { bank: 'HDFC',   platform: 'amazon'   },
    { bank: 'HDFC',   platform: 'flipkart' },
    { bank: 'HDFC',   platform: 'swiggy'   },
    { bank: 'HDFC',   platform: 'zomato'   },
    { bank: 'HDFC',   platform: 'myntra'   },
    { bank: 'Axis',   platform: 'amazon'   },
    { bank: 'Axis',   platform: 'flipkart' },
    { bank: 'Axis',   platform: 'swiggy'   },
    { bank: 'Axis',   platform: 'zomato'   },
    { bank: 'ICICI',  platform: 'amazon'   },
    { bank: 'ICICI',  platform: 'flipkart' },
    { bank: 'ICICI',  platform: 'swiggy'   },
    { bank: 'SBI',    platform: 'amazon'   },
    { bank: 'SBI',    platform: 'flipkart' },
    { bank: 'SBI',    platform: 'irctc'    },
    { bank: 'Kotak',  platform: 'amazon'   },
    { bank: 'Kotak',  platform: 'swiggy'   },
    { bank: 'IDFC',   platform: 'swiggy'   },
    { bank: 'IDFC',   platform: 'amazon'   },
    { bank: 'Amex',   platform: 'amazon'   },
    { bank: 'IndusInd', platform: 'amazon' },
    { bank: 'IndusInd', platform: 'swiggy' },
    { bank: 'HSBC',   platform: 'amazon'   },
    { bank: 'HSBC',   platform: 'flipkart' },
    { bank: 'Yes Bank', platform: 'amazon' },
    { bank: 'RBL',    platform: 'zomato'   },
    { bank: 'RBL',    platform: 'amazon'   },
  ];

  const platformList = [
    'amazon','flipkart','swiggy','zomato','myntra','ajio','bigbasket',
    'blinkit','nykaa','makemytrip','irctc','bookmyshow','meesho',
    'tatacliq','jiomart','nykaafashion','eazydiner','zepto','dmartready',
    'swiggyinstamart','goibibo','cleartrip','easemytrip','pvr','inox',
    'hotstar','pharmeasy','netmeds','onemg','iocl','hpcl','phonepe'
  ];

  // Map platform id to display name for better search queries
  const platformNames = {
    amazon: 'Amazon', flipkart: 'Flipkart', swiggy: 'Swiggy',
    zomato: 'Zomato', myntra: 'Myntra', ajio: 'Ajio',
    bigbasket: 'BigBasket', blinkit: 'Blinkit', nykaa: 'Nykaa',
    makemytrip: 'MakeMyTrip', irctc: 'IRCTC', bookmyshow: 'BookMyShow',
    meesho: 'Meesho', tatacliq: 'Tata CLiQ', jiomart: 'JioMart',
    zepto: 'Zepto', goibibo: 'Goibibo', cleartrip: 'Cleartrip',
    easemytrip: 'EaseMyTrip', pvr: 'PVR Cinemas', hotstar: 'Hotstar',
    pharmeasy: 'PharmEasy', netmeds: 'Netmeds', onemg: '1mg',
    iocl: 'Indian Oil', hpcl: 'HP Petrol', phonepe: 'PhonePe',
  };

  let totalSaved = 0;
  const today = new Date();
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const defaultValidity = `30 ${monthNames[today.getMonth() + 2 > 11 ? 0 : today.getMonth() + 2]} ${today.getMonth() + 2 > 11 ? today.getFullYear() + 1 : today.getFullYear()}`;

  for (const target of searchTargets) {
    try {
      const platformDisplayName = platformNames[target.platform] || target.platform;
      const searchQuery = `${target.bank} bank credit card cashback discount offers on ${platformDisplayName} India 2026 current active`;

      console.log(`[Auto-update] Searching: ${target.bank} / ${platformDisplayName}...`);

      // Step 1 — Ask Perplexity to search and summarise current offers
      const perplexityResponse = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${perplexityKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful assistant that finds current Indian bank credit card offers. Be specific about discount percentages, caps, and validity dates. Only report currently active offers.'
            },
            {
              role: 'user',
              content: searchQuery
            }
          ],
          max_tokens: 1000,
          temperature: 0.1,
          return_citations: false,
        })
      });

      if (!perplexityResponse.ok) {
        const errText = await perplexityResponse.text();
        console.warn(`[Auto-update] Perplexity error for ${target.bank}/${target.platform}: ${perplexityResponse.status} — ${errText.substring(0,100)}`);
        continue;
      }

      const perplexityData = await perplexityResponse.json();
      const searchResult = perplexityData?.choices?.[0]?.message?.content || '';

      if (!searchResult || searchResult.length < 50) {
        console.warn(`[Auto-update] ${target.bank}/${target.platform}: No useful content from Perplexity — skipping`);
        continue;
      }

      console.log(`[Auto-update] Got ${searchResult.length} chars from Perplexity for ${target.bank}/${target.platform}`);

      // Step 2 — Ask Claude to extract structured JSON from Perplexity's result
      const aiResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Extract all credit card offers for ${target.bank} bank on ${platformDisplayName} from the text below.
Return ONLY a valid JSON array, no explanation, no markdown backticks.

Each offer must have exactly these fields:
- bank: "${target.bank}"
- card: "Credit" or "Debit"
- variant: specific card variant name like "Millennia" or "Regalia", or "All" if applies to all cards
- platform: "${target.platform}"
- value: the discount like "10%" or "500" or "5x points"
- type: "cashback" or "flat" or "points"
- title: short title max 60 chars
- description: brief description max 120 chars
- cap: maximum cap like "Max 500" or "No cap"
- validity: expiry date as "DD Mon YYYY" — if not mentioned use "${defaultValidity}"
- min_spend: minimum order amount as integer (e.g. 500 for "min order Rs 500"), or 0 if not mentioned
- best: true only if cashback is 10% or more or flat discount is 500 or more, otherwise false

If no specific offers found, return empty array: []

Text to extract from:
${searchResult}

Return only the JSON array:`
        }]
      });

      const responseText = aiResponse.content[0].text.trim();
      const cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();

      let extractedOffers;
      try {
        extractedOffers = JSON.parse(cleanedJson);
        if (!Array.isArray(extractedOffers)) extractedOffers = [];
      } catch (e) {
        console.warn(`[Auto-update] ${target.bank}/${target.platform}: JSON parse failed — skipping`);
        continue;
      }

      console.log(`[Auto-update] ${target.bank}/${target.platform}: ${extractedOffers.length} offers extracted`);

      // Step 3 — Save new offers to database, skip duplicates
      let saved = 0;
      for (const offer of extractedOffers) {
        if (!offer.title || !offer.value) continue;
        if (!platformList.includes(offer.platform)) continue;

        try {
          // Fix 11: Improved dedup — check value similarity within 10% for cashback
          const existing = await pool.query(
            `SELECT id, value FROM offers WHERE bank=$1 AND platform=$2 AND card=$3 AND status='active'`,
            [target.bank, target.platform, offer.card || 'Credit']
          );
          const offerNum = parseFloat((offer.value||'').replace(/[^0-9.]/g,'')) || 0;
          const isDuplicate = existing.rows.some(row => {
            const rowNum = parseFloat((row.value||'').replace(/[^0-9.]/g,'')) || 0;
            if (offerNum === 0 || rowNum === 0) return row.value === offer.value;
            return Math.abs(offerNum - rowNum) / Math.max(offerNum, rowNum) < 0.10;
          });
          if (isDuplicate) {
            console.log(`[Auto-update] Skipping duplicate: ${target.bank} ${offer.value} on ${target.platform}`);
            continue;
          }

          const offerId = `perp_${target.bank.toLowerCase().replace(/\s/g,'_')}_${target.platform}_${Date.now()}_${saved}`;
          // Find source URL for this bank from bank_sources
          const sourceRow = await pool.query(
            'SELECT url FROM bank_sources WHERE bank=$1 AND platform=$2 LIMIT 1',
            [target.bank, target.platform]
          );
          const sourceUrl = sourceRow.rows[0]?.url || null;

          await pool.query(
            `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best, min_spend, source_url)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              offerId,
              target.bank,
              offer.card || 'Credit',
              offer.variant || 'All',
              target.platform,
              offer.value,
              offer.type || 'cashback',
              offer.title,
              offer.description || '',
              offer.cap || 'No cap',
              offer.validity || defaultValidity,
              offer.best === true,
              parseInt(offer.min_spend) || 0,
              sourceUrl,
            ]
          );
          saved++;
          console.log(`[Auto-update] Saved: ${target.bank} — ${offer.title}`);
        } catch (e) {
          console.warn(`[Auto-update] Could not save offer:`, e.message);
        }
      }

      totalSaved += saved;
      console.log(`[Auto-update] ${target.bank}/${target.platform}: ${saved} new offers saved.`);

      // Small delay between requests to be respectful to APIs
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      console.error(`[Auto-update] Failed for ${target.bank}/${target.platform}:`, err.message);
    }
  }

  console.log(`[Auto-update] Crawl complete. Total new offers saved: ${totalSaved}`);
  return totalSaved;
}

// ─── Step 4: Manual /crawl endpoint for testing ───────────────────────────────
app.get('/crawl', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    console.log('[Crawl] Manual crawl triggered via /crawl endpoint');
    const saved = await crawlAndUpdateOffers();
    res.json({
      success: true,
      message: `Crawl complete. ${saved} new offers saved to database.`
    });
  } catch (e) {
    console.error('[Crawl] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Diagnostic endpoint — tests Perplexity key and one search ───────────────
// Open in browser: https://cardoffers-server.onrender.com/crawl-test
app.get('/crawl-test', requireAdminKey, adminLimiter, async (req, res) => {
  const results = {};

  // Check 1 — are API keys present?
  results.anthropic_key_present = !!process.env.ANTHROPIC_API_KEY;
  results.perplexity_key_present = !!process.env.PERPLEXITY_API_KEY;

  if (!process.env.PERPLEXITY_API_KEY) {
    return res.json({ ...results, error: 'PERPLEXITY_API_KEY is missing from environment variables' });
  }

  // Check 2 — can we reach Perplexity API?
  try {
    const perplexityResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user',   content: 'What is the current HDFC Millennia credit card cashback offer on Amazon India in 2026? Give specific percentage and cap.' }
        ],
        max_tokens: 500,
        temperature: 0.1,
      })
    });

    results.perplexity_http_status = perplexityResponse.status;

    if (!perplexityResponse.ok) {
      const errText = await perplexityResponse.text();
      results.perplexity_error = errText.substring(0, 300);
      return res.json(results);
    }

    const data = await perplexityResponse.json();
    results.perplexity_response = data?.choices?.[0]?.message?.content || 'No content returned';
    results.perplexity_success = true;

  } catch (e) {
    results.perplexity_fetch_error = e.message;
  }

  // Check 3 — can we reach Claude AI?
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Reply with just the word: working' }]
    });
    results.claude_response = msg.content[0].text;
    results.claude_success = true;
  } catch (e) {
    results.claude_error = e.message;
  }

  res.json(results);
});

// ─── Bank sources management endpoints ───────────────────────────────────────
// View all bank sources (admin use)
app.get('/bank-sources', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM bank_sources ORDER BY bank, platform');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add a new bank source
app.post('/bank-sources', requireAdminKey, adminLimiter, async (req, res) => {
  const { bank, platform, url } = req.body;
  if (!bank || !platform || !url) return res.status(400).json({ error: 'bank, platform and url are required' });
  try {
    const result = await pool.query(
      'INSERT INTO bank_sources (bank, platform, url) VALUES ($1, $2, $3) RETURNING *',
      [bank, platform, url]
    );
    res.json({ success: true, source: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Toggle a bank source active/inactive
app.patch('/bank-sources/:id', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE bank_sources SET active = NOT active WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    res.json({ success: true, source: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ─────────────────────────────────────────────────────────────────────────────

// Fix 6: Get recently expired offers (last 30 days)
app.get('/offers/past', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM offers WHERE status='expired' AND created_at > NOW() - INTERVAL '30 days' ORDER BY validity DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/offers/expired', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const deleted = await deleteExpiredOffers();
    res.json({ success: true, removed: deleted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Auto-delete expired offers daily ───────────────────────────────────────
// Runs once at server startup, then every 24 hours automatically
async function deleteExpiredOffers() {
  const months = {
    Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5,
    Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11
  };

  // Fetch all offers and delete ones that are expired
  const result = await pool.query('SELECT id, validity FROM offers');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiredIds = result.rows
    .filter(o => {
      try {
        const parts = (o.validity || '').trim().split(' ');
        if (parts.length < 3) return false;
        const expiry = new Date(parseInt(parts[2]), months[parts[1]], parseInt(parts[0]));
        return expiry < today;
      } catch (e) { return false; }
    })
    .map(o => o.id);

  if (expiredIds.length === 0) {
    console.log(`[Auto-cleanup] No expired offers found.`);
    return 0;
  }

  // Fix 6: Soft-delete — mark as expired instead of hard delete
  await pool.query("UPDATE offers SET status='expired' WHERE id = ANY($1)", [expiredIds]);
  console.log(`[Auto-cleanup] Marked ${expiredIds.length} offer(s) as expired.`);
  return expiredIds.length;
}

// Auto-delete runs every 24 hours
setInterval(() => {
  deleteExpiredOffers().catch(err => console.error('[Auto-cleanup] Scheduled run failed:', err.message));
}, 24 * 60 * 60 * 1000); // 24 hours in milliseconds
// ─────────────────────────────────────────────────────────────────────────────

app.post('/offers/deduplicate', requireAdminKey, adminLimiter, async (req, res) => {
  try {
    const result = await pool.query(`
      DELETE FROM offers
      WHERE id NOT IN (
        SELECT DISTINCT ON (bank, platform, value, card) id
        FROM offers
        ORDER BY bank, platform, value, card, created_at DESC
      )
    `);
    res.json({ success: true, removed: result.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Admin key middleware ─────────────────────────────────────────────────────
// Protects sensitive endpoints. Set ADMIN_SECRET_KEY in Render environment.
function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_SECRET_KEY;
  if (!adminKey) return next(); // if key not set, allow (for backward compat during setup)
  const provided = req.query.key || req.headers['x-admin-key'];
  if (provided !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized. Admin key required.' });
  }
  next();
}
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`CardOffers API running on port ${PORT}`));

    // Run cleanup after DB is confirmed ready
    deleteExpiredOffers().catch(err => console.error('[Auto-cleanup] Startup run failed:', err.message));

    // Run weekly auto-crawl every Sunday at midnight
    setInterval(() => {
      const now = new Date();
      if (now.getDay() === 0 && now.getHours() === 0) {
        console.log('[Auto-update] Weekly crawl starting...');
        crawlAndUpdateOffers().catch(err => console.error('[Auto-update] Weekly crawl failed:', err.message));
        // Send weekly push digest on Sunday evening
        sendWeeklyPushDigest().catch(err => console.error('[Push] Weekly digest failed:', err.message));
      }
    }, 60 * 60 * 1000); // checks every hour

    // ── Keep-alive: self-ping every 10 minutes to prevent Render free tier sleep
    const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    setInterval(() => {
      fetch(`${SERVER_URL}/`)
        .then(() => console.log('[Keep-alive] Server pinged successfully'))
        .catch(() => console.log('[Keep-alive] Ping failed — server may be starting up'));
    }, 10 * 60 * 1000); // every 10 minutes
    console.log('[Keep-alive] Self-ping scheduler started');
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    console.log('Starting server without database...');
    app.listen(PORT, () => console.log(`CardOffers API running on port ${PORT}`));
  });
