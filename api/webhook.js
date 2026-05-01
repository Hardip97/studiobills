const crypto = require('crypto');

const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET        = process.env.RAZORPAY_WEBHOOK_SECRET;

// Amount in paise (Razorpay uses paise, not rupees)
const MONTHLY_AMOUNT = 14900; // ₹149
const YEARLY_AMOUNT  = 99900; // ₹999

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end('Method not allowed');

  // ── 1. Verify Razorpay signature ──
  const signature = req.headers['x-razorpay-signature'];
  if (WEBHOOK_SECRET) {
    if (!signature) return res.status(400).json({ error: 'Missing signature' });
    const bodyStr = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');
    if (signature !== expected) return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = req.body;
  console.log('Webhook received:', event.event);

  // ── 2. Only handle payment.captured ──
  if (event.event !== 'payment.captured') {
    return res.status(200).json({ status: 'ignored', event: event.event });
  }

  const payment = event.payload?.payment?.entity;
  if (!payment) return res.status(200).json({ status: 'no_payment_data' });

  const email      = payment.email?.toLowerCase()?.trim();
  const amountPaise = payment.amount;

  if (!email) return res.status(200).json({ status: 'no_email' });

  // ── 3. Determine plan from amount ──
  const isYearly  = amountPaise === YEARLY_AMOUNT;
  const isMonthly = amountPaise === MONTHLY_AMOUNT;

  if (!isYearly && !isMonthly) {
    console.log('Unknown plan amount:', amountPaise);
    return res.status(200).json({ status: 'unknown_amount', amount: amountPaise });
  }

  // ── 4. Calculate expiry ──
  const expiry = new Date();
  if (isYearly)  expiry.setFullYear(expiry.getFullYear() + 1);
  if (isMonthly) expiry.setMonth(expiry.getMonth() + 1);

  // ── 5. Connect to Supabase with service role key ──
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── 6. Find user by email ──
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) {
    console.error('Error listing users:', listErr.message);
    return res.status(500).json({ error: listErr.message });
  }

  const user = users.find(u => u.email?.toLowerCase() === email);
  if (!user) {
    console.log('⚠️ No StudioBills account found for email:', email);
    return res.status(200).json({ status: 'user_not_found', email });
  }

  // ── 7. Fetch existing user data from Supabase ──
  const { data: userData } = await supabase
    .from('user_data')
    .select('data')
    .eq('user_id', user.id)
    .single();

  const db = userData?.data || {};

  // ── 8. Upgrade plan ──
  db.plan             = 'pro';
  db.planExpiry       = expiry.toISOString();
  db.planType         = isYearly ? 'yearly' : 'monthly';
  db.planActivatedAt  = new Date().toISOString();
  db.planPaymentId    = payment.id;
  db._ts              = Date.now();

  const { error: upsertErr } = await supabase
    .from('user_data')
    .upsert({ user_id: user.id, data: db, updated_at: new Date().toISOString() });

  if (upsertErr) {
    console.error('Error updating plan:', upsertErr.message);
    return res.status(500).json({ error: upsertErr.message });
  }

  console.log(`✅ Plan upgraded: ${email} → ${db.planType}, expires: ${expiry.toISOString()}`);
  return res.status(200).json({ status: 'ok', plan: 'pro', type: db.planType, expiry: expiry.toISOString() });
};
