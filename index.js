const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
      best BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      bank TEXT NOT NULL,
      card_type TEXT NOT NULL,
      variant TEXT NOT NULL,
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
  `);
  console.log('Database tables ready');
}

app.get('/', (req, res) => {
  res.json({ status: 'CardOffers API is running!' });
});

app.get('/offers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM offers ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/offers', async (req, res) => {
  const { id, bank, card, variant, platform, value, type, title, description, cap, validity, best } = req.body;
  try {
    await pool.query(
      `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET bank=$2, card=$3, variant=$4, platform=$5, value=$6, type=$7, title=$8, description=$9, cap=$10, validity=$11, best=$12`,
      [id, bank, card, variant, platform, value, type, title, description, cap, validity, best]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/offers/bulk', async (req, res) => {
  const { offers } = req.body;
  if (!offers || !Array.isArray(offers)) return res.status(400).json({ error: 'Please provide an array of offers.' });
  try {
    let saved = 0;
    for (const o of offers) {
      await pool.query(
        `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET bank=$2, card=$3, variant=$4, platform=$5, value=$6, type=$7, title=$8, description=$9, cap=$10, validity=$11, best=$12`,
        [o.id, o.bank, o.card, o.variant||'All', o.platform, o.value, o.type, o.title, o.description||'', o.cap||'No cap', o.validity, o.best||false]
      );
      saved++;
    }
    res.json({ success: true, saved });
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

app.get('/submissions', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM community_submissions WHERE status='pending' ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/submissions', async (req, res) => {
  const { bank, card, variant, platform, value, type, title, description, cap, validity, submitted_by } = req.body;
  try {
    await pool.query(
      `INSERT INTO community_submissions (bank, card, variant, platform, value, type, title, description, cap, validity, submitted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [bank, card, variant||'All', platform, value, type, title, description||'', cap||'No cap', validity, submitted_by||'anonymous']
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/submissions/:id/approve', async (req, res) => {
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

app.post('/submissions/:id/reject', async (req, res) => {
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
- validity: expiry date in format "DD Mon YYYY" like "30 Apr 2026"
- best: true if this is an exceptional deal, false otherwise

Only include offers for these platforms: amazon, flipkart, swiggy, zomato, myntra, ajio, bigbasket, blinkit, nykaa, makemytrip, irctc, bookmyshow.
Skip any offers for other platforms.
If validity date is not mentioned, use "30 Jun 2026".
If card variant is not mentioned, use "All".

Here is the bank website text:
${text}

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

app.post('/seed', async (req, res) => {
  const defaultOffers = [
    { id:'o1',  bank:'HDFC',  card:'Credit', variant:'Millennia',          platform:'amazon',     value:'5%',   type:'cashback', title:'5% cashback on Amazon Pay',        description:'Earn 5% back on all purchases via Amazon Pay balance.', cap:'150 per txn',     validity:'30 Apr 2026', best:true  },
    { id:'o2',  bank:'HDFC',  card:'Credit', variant:'Regalia',             platform:'flipkart',   value:'10%',  type:'cashback', title:'10% instant discount on Flipkart', description:'Get 10% off on orders above 3000.',                     cap:'Max 1500',        validity:'30 Apr 2026', best:true  },
    { id:'o3',  bank:'HDFC',  card:'Credit', variant:'Millennia',          platform:'swiggy',     value:'100',  type:'flat',     title:'100 off on Swiggy orders',         description:'Flat 100 off on 3 orders per month. Min order 299.',    cap:'3 uses per month',validity:'20 Apr 2026', best:false },
    { id:'o4',  bank:'HDFC',  card:'Credit', variant:'Infinia',             platform:'makemytrip', value:'12%',  type:'cashback', title:'12% off on flights and hotels',    description:'12% instant discount on domestic flights and hotels.',  cap:'Max 3000',        validity:'31 May 2026', best:true  },
    { id:'o5',  bank:'HDFC',  card:'Credit', variant:'Regalia',             platform:'myntra',     value:'15%',  type:'cashback', title:'15% cashback on Myntra',           description:'Earn 15% cashback on fashion purchases above 1500.',   cap:'Max 500',         validity:'30 Apr 2026', best:true  },
    { id:'o6',  bank:'Axis',  card:'Credit', variant:'Flipkart Axis',      platform:'swiggy',     value:'20%',  type:'cashback', title:'20% off on Swiggy',                description:'Use Flipkart Axis Card for 20% off every Swiggy order.',cap:'Max 150 per order',validity:'30 Apr 2026', best:true  },
    { id:'o7',  bank:'Axis',  card:'Credit', variant:'MY Zone',            platform:'zomato',     value:'10%',  type:'cashback', title:'10% cashback on Zomato',           description:'Get 10% cashback on Zomato orders. Min 250.',          cap:'Max 100 per txn', validity:'25 Apr 2026', best:false },
    { id:'o8',  bank:'Axis',  card:'Credit', variant:'Ace',                platform:'amazon',     value:'5%',   type:'cashback', title:'5% cashback on Amazon Axis Ace',   description:'Earn 5% cashback on Amazon with Axis Ace Credit Card.', cap:'Max 200 per month',validity:'30 Apr 2026', best:false },
    { id:'o9',  bank:'Axis',  card:'Credit', variant:'Flipkart Axis',      platform:'flipkart',   value:'5%',   type:'cashback', title:'5% cashback on Flipkart',          description:'Unlimited 5% cashback on all Flipkart purchases.',      cap:'No cap',          validity:'31 May 2026', best:true  },
    { id:'o10', bank:'SBI',   card:'Credit', variant:'SimplyCLICK',        platform:'amazon',     value:'10%',  type:'cashback', title:'10% off on Amazon',                description:'10% instant discount on Amazon Great Summer Sale.',     cap:'Max 1750',        validity:'15 May 2026', best:true  },
    { id:'o11', bank:'SBI',   card:'Credit', variant:'IRCTC SBI Platinum', platform:'irctc',      value:'100',  type:'flat',     title:'100 off on IRCTC',                 description:'Flat 100 off on train ticket bookings on IRCTC.',       cap:'1 use per month', validity:'31 Dec 2026', best:true  },
    { id:'o12', bank:'ICICI', card:'Credit', variant:'Amazon Pay ICICI',   platform:'amazon',     value:'5%',   type:'cashback', title:'5% cashback Amazon Pay ICICI',     description:'Earn 5% on Amazon with Amazon Pay ICICI Credit Card.',  cap:'Unlimited',       validity:'31 Dec 2026', best:true  },
    { id:'o13', bank:'ICICI', card:'Credit', variant:'MakeMyTrip ICICI',   platform:'makemytrip', value:'15%',  type:'cashback', title:'15% off on MakeMyTrip',            description:'15% off on flights and hotels via MakeMyTrip.',        cap:'Max 2000',        validity:'31 May 2026', best:true  },
    { id:'o14', bank:'Kotak', card:'Credit', variant:'League Platinum',    platform:'amazon',     value:'7.5%', type:'cashback', title:'7.5% cashback on Amazon',          description:'Earn 7.5% cashback with Kotak League Platinum.',       cap:'Max 500 per month',validity:'30 Apr 2026', best:true  },
    { id:'o15', bank:'IDFC',  card:'Credit', variant:'FIRST Millenia',     platform:'swiggy',     value:'100',  type:'flat',     title:'100 off on Swiggy IDFC',           description:'Flat 100 off every Swiggy order. Min 300.',            cap:'5 uses per month',validity:'30 Apr 2026', best:true  },
    { id:'o16', bank:'Amex',  card:'Credit', variant:'Gold Card',          platform:'amazon',     value:'5x',   type:'points',   title:'5x reward points on Amazon',       description:'Earn 5x Membership Rewards points on Amazon.',         cap:'No cap',          validity:'31 Dec 2026', best:true  },
    { id:'o17', bank:'Citi',  card:'Credit', variant:'Cashback',           platform:'amazon',     value:'10%',  type:'cashback', title:'10% cashback Citi on Amazon',      description:'10% cashback on Amazon via Citi Cashback Card.',       cap:'Max 1000 per month',validity:'30 Apr 2026', best:true  },
    { id:'o18', bank:'SBI',   card:'Credit', variant:'SimplyCLICK',        platform:'bookmyshow', value:'25%',  type:'cashback', title:'25% off on BookMyShow',            description:'25% off on movie tickets. Min 2 tickets.',            cap:'Max 200 per txn', validity:'30 Apr 2026', best:true  },
    { id:'o19', bank:'Axis',  card:'Credit', variant:'Magnus',             platform:'nykaa',      value:'15%',  type:'cashback', title:'15% cashback on Nykaa',            description:'Earn 15% cashback on beauty and wellness on Nykaa.',  cap:'Max 300',         validity:'30 Apr 2026', best:true  },
    { id:'o20', bank:'HDFC',  card:'Credit', variant:'Infinia',            platform:'bookmyshow', value:'20%',  type:'cashback', title:'20% off on BookMyShow',            description:'Get 20% off on movie and event tickets.',             cap:'Max 400 per txn', validity:'30 Apr 2026', best:false },
  ];
  try {
    for (const o of defaultOffers) {
      await pool.query(
        `INSERT INTO offers (id, bank, card, variant, platform, value, type, title, description, cap, validity, best) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
        [o.id, o.bank, o.card, o.variant, o.platform, o.value, o.type, o.title, o.description, o.cap, o.validity, o.best]
      );
    }
    res.json({ success: true, message: `${defaultOffers.length} offers seeded.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => {
    app.listen(PORT, () => console.log(`CardOffers API running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Database connection failed:', err.message);
    console.log('Starting server without database...');
    app.listen(PORT, () => console.log(`CardOffers API running on port ${PORT}`));
  });
