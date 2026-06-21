import twilio from 'twilio';

// Use the Vercel standard req/res
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  try {
    // Twilio sends data as application/x-www-form-urlencoded
    const { From, Body } = req.body || {};
    
    if (!From || !Body) {
      return res.status(400).send('Missing From or Body');
    }

    // From looks like "whatsapp:+14155238886"
    const senderNumber = From.replace('whatsapp:', '').trim();
    const text = Body.trim();

    // 1. Helper to fetch from Supabase
    async function supaFetch(path, method = 'GET', body = null) {
      const url  = `${process.env.SUPABASE_URL}${path}`;
      const opts = {
        method,
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation',
        },
      };
      if (body) opts.body = JSON.stringify(body);
      const resp = await fetch(url, opts);
      if (!resp.ok) {
        console.error('Supabase fetch failed:', await resp.text());
        return null;
      }
      try { return await resp.json(); } catch { return null; }
    }

    // 2. Find User in Supabase
    // We fetch all rows and filter in JS to handle phone number formatting inconsistencies
    // Note: If you have >10k users, you should use a proper JSONB query or indexed column instead
    const usersRows = await supaFetch('/rest/v1/user_data?select=user_id,data');
    if (!usersRows) {
      return reply(res, "❌ Internal error connecting to database.");
    }

    let targetUser = null;

    const normalizedSender = senderNumber.replace(/\D/g, ''); // strip non-digits
    
    for (const row of usersRows) {
      const profile = row.data?.profile || {};
      if (profile.whatsapp) {
        const normalizedDbNum = profile.whatsapp.replace(/\D/g, '');
        if (normalizedDbNum === normalizedSender) {
          targetUser = row;
          break;
        }
      }
    }

    if (!targetUser) {
      return reply(res, "❌ Your WhatsApp number is not linked to any StudioBills account. Please add it in your Settings.");
    }

    // 3. Parse the message (Format: "Expense <amount> <category>" or "Income <amount> <category>")
    const match = text.match(/^(expense|income|exp|inc)\s+([\d.,]+)(?:\s+(.+))?$/i);
    if (!match) {
      return reply(res, "🤖 Could not understand. Try format: 'Expense 500 Food' or 'Income 2000 Salary'");
    }

    const typeStr = match[1].toLowerCase();
    const amountStr = match[2].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    let category = match[3] ? match[3].trim() : 'Uncategorized';

    if (isNaN(amount)) {
      return reply(res, "❌ Invalid amount.");
    }

    const isExpense = ['expense', 'exp'].includes(typeStr);
    const type = isExpense ? 'expense' : 'income';

    // 4. Update the user's data
    const userData = targetUser.data;
    if (!userData.transactions) {
      userData.transactions = [];
    }

    const newTx = {
      id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2,9),
      type: type,
      amount: amount,
      cat: category,
      date: new Date().toISOString().split('T')[0], // Today's date YYYY-MM-DD
      note: 'Added via WhatsApp',
      ts: Date.now()
    };

    userData.transactions.push(newTx);
    
    // add category to profile categories if it doesn't exist
    if (!userData.cats) userData.cats = { inc: [], exp: [] };
    if (!userData.cats.inc) userData.cats.inc = [];
    if (!userData.cats.exp) userData.cats.exp = [];
    
    const catList = isExpense ? userData.cats.exp : userData.cats.inc;
    if (category !== 'Uncategorized' && !catList.includes(category)) {
      catList.push(category);
    }

    userData._ts = Date.now();

    // Save back to DB
    await supaFetch(`/rest/v1/user_data?user_id=eq.${targetUser.user_id}`, 'PATCH', { data: userData });

    // 5. Send Success Reply
    const currency = userData.profile?.currency || '₹';
    const msg = `✅ ${isExpense ? 'Expense' : 'Income'} of ${currency}${amount} added to ${category} successfully!`;
    return reply(res, msg);

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).send('Internal Server Error');
  }
}

// Helper to send TwiML XML reply
function reply(res, message) {
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(message);
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(twiml.toString());
}
