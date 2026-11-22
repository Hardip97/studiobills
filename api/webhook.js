/**
 * StudioBills — Razorpay Webhook Handler
 * Vercel Serverless Function: /api/webhook
 *
 * Flow:
 *   User pays on Razorpay → Razorpay POSTs this URL → Plan updated in Supabase
 *   User returns to app → visibilitychange fires → refreshPlanFromSupabase() → Pro unlocked ✓
 *
 * Env vars needed in Vercel (Settings → Environment Variables):
 *   RAZORPAY_WEBHOOK_SECRET   — Razorpay Dashboard → Settings → Webhooks
 *   SUPABASE_URL              — your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase Dashboard → Settings → API → service_role key
 */

import crypto from 'crypto';

// Disable Vercel body parser so we can verify the raw body signature
export const config = {
  api: { bodyParser: false },
};

// ── helpers ───────────────────────────────────────────────────────────────────

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function supaFetch(path, method = 'GET', body = null) {
  const url  = `${process.env.SUPABASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

async function findUserByEmail(email) {
  for (let page = 1; page <= 50; page++) {
    const authData = await supaFetch(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const users = authData?.users || [];
    const match = users.find(u => u.email?.toLowerCase() === email);
    if (match) return match;
    if (users.length < 1000) break;
  }
  return null;
}

// ── main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Read raw body
  const rawBody = await getRawBody(req);

  // 2. Verify Razorpay HMAC-SHA256 signature
  const signature = req.headers['x-razorpay-signature'];
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!signature || !secret) {
    console.error('Missing signature or RAZORPAY_WEBHOOK_SECRET env var');
    return res.status(400).json({ error: 'Missing signature' });
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const sigBuf = Buffer.from(String(signature));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    console.error('Razorpay signature mismatch — possible fake request');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  // 3. Parse event
  let event;
  try { event = JSON.parse(rawBody); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const eventType = event.event;
  console.log(`Razorpay event received: ${eventType}`);

  // 4. Only handle payment success events — ignore everything else
  if (!['payment_link.paid', 'payment.captured'].includes(eventType)) {
    return res.status(200).json({ received: true, skipped: true });
  }

  // 5. Extract payment details
  const payment = event.payload?.payment?.entity;
  const email   = payment?.email?.toLowerCase().trim();
  const amount  = payment?.amount || 0; // paise (₹1 = 100 paise)

  if (!email) {
    console.error('No email in Razorpay payload');
    return res.status(400).json({ error: 'No email in payment' });
  }

  // 6. Determine plan type from amount
  //    Monthly ₹149 = 14900 paise  → 31 days
  //    Yearly  ₹999 = 99900 paise  → 366 days
  const isYearly   = amount >= 50000;
  const planDays   = isYearly ? 366 : 31;
  const planExpiry = new Date(Date.now() + planDays * 86400 * 1000).toISOString();

  console.log(`Payment: ${email} | ₹${amount / 100} | ${isYearly ? 'yearly' : 'monthly'}`);

  const paymentId = payment?.id || '';

  try {
    // 7. Find Supabase user by email (paginated admin API)
    const user = await findUserByEmail(email);

    if (!user) {
      console.warn(`No user found for ${email} — queuing pending plan`);
      await supaFetch('/rest/v1/pending_plans', 'POST', {
        email,
        plan:         'pro',
        plan_expiry:  planExpiry,
        paid_at:      new Date().toISOString(),
        amount_paise: amount,
      });
      return res.status(200).json({ queued: true, email });
    }

    // 8. Get existing user data (to preserve income/expenses etc.)
    const rows     = await supaFetch(`/rest/v1/user_data?user_id=eq.${user.id}&select=data`);
    const existing = rows?.[0]?.data || {};

    // Idempotency guard across payment_link.paid + payment.captured
    const processed = Array.isArray(existing._processedPayments) ? existing._processedPayments : [];
    if (paymentId && processed.includes(paymentId)) {
      return res.status(200).json({ received: true, duplicate: true, paymentId });
    }

    // Extend from existing future expiry if renewing early
    const currentExpMs = existing.planExpiry ? Date.parse(existing.planExpiry) : 0;
    const baseMs = Number.isFinite(currentExpMs) && currentExpMs > Date.now() ? currentExpMs : Date.now();
    const nextExpiry = new Date(baseMs + planDays * 86400 * 1000).toISOString();

    // 9. Merge plan into existing data — never overwrite income/expense records
    const updated = {
      ...existing,
      plan:       'pro',
      planExpiry: nextExpiry,
      _processedPayments: paymentId ? [...processed.slice(-49), paymentId] : processed,
      _ts:        Date.now(),
    };

    await supaFetch('/rest/v1/user_data', 'POST', {
      user_id: user.id,
      data:    updated,
    });
  } catch (err) {
    console.error('Webhook persistence error:', err.message);
    return res.status(500).json({ error: 'Database update failed' });
  }

  console.log(`✅ Pro activated: ${email} | expires ${planExpiry}`);
  return res.status(200).json({
    success:   true,
    email,
    plan:      'pro',
    expiry:    planExpiry,
    plan_type: isYearly ? 'yearly' : 'monthly',
  });
}
