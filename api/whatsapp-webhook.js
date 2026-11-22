import twilio from 'twilio';

const DEFAULT_CATS = {
  inc: ['Design', 'Photography', 'Video', 'Consulting', 'Development', 'Writing', 'Marketing', 'Other'],
  exp: ['Software', 'Equipment', 'Travel', 'Marketing', 'Rent', 'Utilities', 'Food', 'Other'],
};

function todayIST() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function uid(prefix = 'wa') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizePhone(value = '') {
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

function parseFormParams(rawBody, parsedBody) {
  if (parsedBody && typeof parsedBody === 'object' && Object.keys(parsedBody).length) {
    return parsedBody;
  }
  return Object.fromEntries(new URLSearchParams(rawBody || '').entries());
}

function verifyTwilioSignature(req, params) {
  const authToken = process.env.TWILIO_AUTH_TOKEN || '';
  const signature = req.headers?.['x-twilio-signature'] || '';
  if (!authToken || !signature) return false;
  const proto = (req.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host || '';
  const fullUrl = `${proto}://${host}${req.url || '/api/whatsapp-webhook'}`;
  return twilio.validateRequest(authToken, signature, fullUrl, params);
}

function parseTwilioBody(rawBody, parsedBody) {
  if (parsedBody && typeof parsedBody === 'object' && parsedBody.From) return parsedBody;
  const params = new URLSearchParams(rawBody || '');
  return {
    From: params.get('From') || '',
    Body: params.get('Body') || '',
    ProfileName: params.get('ProfileName') || '',
  };
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function supaFetch(path, method = 'GET', body = null) {
  const url = `${process.env.SUPABASE_URL}${path}`;
  const opts = {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    console.error('Supabase fetch failed:', resp.status, await resp.text());
    return null;
  }
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

function buildHelpMessage() {
  return [
    'Try one of these:',
    'Expense 500 Food',
    'Expense 1499 Adobe subscription',
    'Income 12000 Retainer',
    'Income 8000 Wedding teaser',
  ].join('\n');
}

function pickCategory(type, text) {
  const cleaned = (text || '').trim();
  if (!cleaned) return 'Other';
  const list = type === 'expense' ? DEFAULT_CATS.exp : DEFAULT_CATS.inc;
  const found = list.find(cat => cleaned.toLowerCase().includes(cat.toLowerCase()));
  return found || cleaned;
}

function parseMessage(text) {
  const clean = (text || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { kind: 'help' };
  if (/^(help|hi|hello|menu)$/i.test(clean)) return { kind: 'help' };

  const match = clean.match(/^(expense|exp|income|inc)\s+([\d.,]+)(?:\s+(.+))?$/i);
  if (!match) return { kind: 'unknown' };

  const rawType = match[1].toLowerCase();
  const amount = parseFloat(match[2].replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return { kind: 'invalid_amount' };

  const rest = (match[3] || '').trim();
  const isExpense = rawType === 'expense' || rawType === 'exp';
  return {
    kind: 'entry',
    type: isExpense ? 'expense' : 'income',
    amount: Math.round(amount),
    text: rest,
    category: pickCategory(isExpense ? 'expense' : 'income', rest),
  };
}

function addIncomeEntry(data, parsed, senderName) {
  const desc = parsed.text || 'Added from WhatsApp';
  const client = senderName || 'WhatsApp';
  const entry = {
    id: uid('inc'),
    invNo: '',
    client,
    desc,
    cat: parsed.category,
    date: todayIST(),
    due: '',
    items: [{ desc, qty: 1, rate: parsed.amount, amount: parsed.amount }],
    amount: parsed.amount,
    received: parsed.amount,
    status: 'received',
    currency: 'INR',
    exchangeRate: 1,
    foreignAmount: parsed.amount,
    notes: 'Added via WhatsApp',
    _totals: {
      subtotal: parsed.amount,
      gross: parsed.amount,
      gst: 0,
      tds: 0,
      discount: 0,
      net: parsed.amount,
    },
  };
  data.income = Array.isArray(data.income) ? data.income : [];
  data.income.unshift(entry);
  return entry;
}

function addExpenseEntry(data, parsed) {
  const title = parsed.text || parsed.category || 'WhatsApp expense';
  const entry = {
    id: uid('exp'),
    title,
    amount: parsed.amount,
    cat: parsed.category,
    date: todayIST(),
    notes: 'Added via WhatsApp',
    recurring: false,
    receipt: '',
  };
  data.expenses = Array.isArray(data.expenses) ? data.expenses : [];
  data.expenses.unshift(entry);
  return entry;
}

function ensureCategories(data, type, category) {
  data.cats = data.cats || {};
  data.cats.inc = Array.isArray(data.cats.inc) ? data.cats.inc : [...DEFAULT_CATS.inc];
  data.cats.exp = Array.isArray(data.cats.exp) ? data.cats.exp : [...DEFAULT_CATS.exp];
  const bucket = type === 'expense' ? data.cats.exp : data.cats.inc;
  if (category && !bucket.includes(category)) bucket.push(category);
}

function reply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
}

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    const rawBody = await getRawBody(req);
    const formParams = parseFormParams(rawBody, req.body);
    if (!verifyTwilioSignature(req, formParams)) {
      return res.status(403).send('Invalid Twilio signature');
    }
    const { From, Body, ProfileName } = parseTwilioBody(rawBody, formParams);
    if (!From || !Body) return reply(res, 'Missing WhatsApp message details.');

    const senderNumber = normalizePhone(From.replace('whatsapp:', ''));
    const parsed = parseMessage(Body);

    if (parsed.kind === 'help') {
      return reply(res, buildHelpMessage());
    }
    if (parsed.kind === 'invalid_amount') {
      return reply(res, 'Please send a valid amount. Example: Expense 500 Food');
    }
    if (parsed.kind === 'unknown') {
      return reply(res, `I couldn't understand that.\n\n${buildHelpMessage()}`);
    }

    const usersRows = await supaFetch('/rest/v1/user_data?select=user_id,data');
    if (!usersRows) return reply(res, 'StudioBills could not connect to the database right now.');

    const targetUser = usersRows.find(row => {
      const linked = normalizePhone(row?.data?.profile?.whatsapp || '');
      return linked && linked === senderNumber;
    });

    if (!targetUser) {
      return reply(res, 'Your WhatsApp number is not linked to a StudioBills account yet. Add it in Settings first.');
    }

    const userData = targetUser.data || {};
    userData.profile = userData.profile || {};
    userData.profile.whatsappPrefs = {
      enabled: false,
      taskReminders: true,
      dueReminders: true,
      dailyDigest: false,
      ...(userData.profile.whatsappPrefs || {}),
    };

    if (!userData.profile.whatsappPrefs.enabled) {
      return reply(res, 'WhatsApp automation is turned off for this account. Enable it in Settings first.');
    }

    let created;
    if (parsed.type === 'expense') created = addExpenseEntry(userData, parsed);
    else created = addIncomeEntry(userData, parsed, ProfileName);

    ensureCategories(userData, parsed.type, parsed.category);
    userData._ts = Date.now();

    const saved = await supaFetch(`/rest/v1/user_data?user_id=eq.${targetUser.user_id}`, 'PATCH', { data: userData });
    if (!saved) return reply(res, 'The entry could not be saved right now. Please try again in a minute.');

    const currency = userData.profile?.currency || '₹';
    const summary = parsed.type === 'expense'
      ? `Expense saved: ${currency}${created.amount} in ${created.cat || 'Other'}`
      : `Income saved: ${currency}${created.amount} from ${created.client}`;
    return reply(res, `${summary}\n${created.desc || created.title || ''}`.trim());
  } catch (error) {
    console.error('WhatsApp webhook error:', error);
    return res.status(500).send('Internal Server Error');
  }
}
