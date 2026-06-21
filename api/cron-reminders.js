import twilio from 'twilio';

function formatDateInTZ(date, timeZone = 'Asia/Kolkata') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function shiftDate(base, days, timeZone = 'Asia/Kolkata') {
  const next = new Date(base);
  next.setUTCDate(next.getUTCDate() + days);
  return formatDateInTZ(next, timeZone);
}

function normalizePhone(value = '') {
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return `${hasPlus ? '+' : ''}${digits}`;
}

function rcv(item) {
  const received = +item?.received || 0;
  return received === 0 && item?.status === 'received' ? (+item?.amount || 0) : received;
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

function buildTaskLines(tasks, dayLabel) {
  return tasks.map(task => {
    const timePart = task.time ? ` at ${task.time}` : '';
    const notePart = task.note ? ` — ${task.note}` : '';
    return `• ${task.title} (${dayLabel}${timePart})${notePart}`;
  });
}

function buildDueLines(invoices, currency) {
  return invoices.map(inv => {
    const balance = Math.max((+inv.amount || 0) - rcv(inv), 0);
    return `• ${inv.invNo || 'Invoice'} · ${inv.client || 'Client'} · ${currency}${balance.toLocaleString('en-IN')} due ${inv.due}`;
  });
}

function shouldIncludeTask(task, today, tomorrow, prefs) {
  if (task.done) return false;
  if (!prefs.taskReminders) return false;
  if (task.date === today) return true;
  return !!prefs.dailyDigest && task.date === tomorrow;
}

function shouldIncludeDue(inv, today, tomorrow, prefs) {
  if (!prefs.dueReminders) return false;
  if (!inv?.due || inv.status === 'received' || inv.status === 'draft') return false;
  return inv.due === today || inv.due === tomorrow;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    const twilioPhone = process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886';
    const now = new Date();
    const today = formatDateInTZ(now);
    const tomorrow = shiftDate(now, 1);

    const usersRows = await supaFetch('/rest/v1/user_data?select=user_id,data');
    if (!usersRows) {
      return res.status(500).json({ error: 'Internal error connecting to database.' });
    }

    let messagesSent = 0;

    for (const row of usersRows) {
      const data = row.data || {};
      const profile = data.profile || {};
      const prefs = {
        enabled: false,
        taskReminders: true,
        dueReminders: true,
        dailyDigest: false,
        ...(profile.whatsappPrefs || {}),
      };

      const phone = normalizePhone(profile.whatsapp || '');
      if (!prefs.enabled || !phone) continue;

      const taskItems = (data.calendar || []).filter(task => shouldIncludeTask(task, today, tomorrow, prefs));
      const dueItems = (data.income || []).filter(inv => shouldIncludeDue(inv, today, tomorrow, prefs));

      const waMeta = {
        sentKeys: {},
        ...(data._waMeta || {}),
      };

      const nextSentKeys = { ...waMeta.sentKeys };
      const freshTaskItems = taskItems.filter(task => {
        const scope = task.date === tomorrow ? 'tomorrow' : 'today';
        const key = `task:${task.id}:${scope}`;
        if (nextSentKeys[key] === today) return false;
        nextSentKeys[key] = today;
        return true;
      });
      const freshDueItems = dueItems.filter(inv => {
        const scope = inv.due === tomorrow ? 'tomorrow' : 'today';
        const key = `due:${inv.id}:${scope}`;
        if (nextSentKeys[key] === today) return false;
        nextSentKeys[key] = today;
        return true;
      });

      if (!freshTaskItems.length && !freshDueItems.length) continue;

      const currency = profile.currency || '₹';
      const lines = ['StudioBills reminder'];
      const todaysTasks = freshTaskItems.filter(task => task.date === today);
      const tomorrowsTasks = freshTaskItems.filter(task => task.date === tomorrow);
      const todaysDue = freshDueItems.filter(inv => inv.due === today);
      const tomorrowsDue = freshDueItems.filter(inv => inv.due === tomorrow);

      if (todaysTasks.length) {
        lines.push('', 'Today');
        lines.push(...buildTaskLines(todaysTasks, 'today'));
      }
      if (tomorrowsTasks.length) {
        lines.push('', 'Tomorrow');
        lines.push(...buildTaskLines(tomorrowsTasks, 'tomorrow'));
      }
      if (todaysDue.length) {
        lines.push('', 'Invoices due today');
        lines.push(...buildDueLines(todaysDue, currency));
      }
      if (tomorrowsDue.length) {
        lines.push('', 'Invoices due tomorrow');
        lines.push(...buildDueLines(tomorrowsDue, currency));
      }
      lines.push('', "Reply with 'Expense 500 Food' or 'Income 12000 Retainer'.");

      try {
        await twilioClient.messages.create({
          body: lines.join('\n'),
          from: `whatsapp:${twilioPhone.replace('whatsapp:', '')}`,
          to: `whatsapp:${phone}`,
        });
        data._waMeta = { ...waMeta, sentKeys: nextSentKeys, lastSentAt: new Date().toISOString() };
        data._ts = Date.now();
        await supaFetch(`/rest/v1/user_data?user_id=eq.${row.user_id}`, 'PATCH', { data });
        messagesSent++;
      } catch (twErr) {
        console.error(`Failed to send to ${phone}:`, twErr.message);
      }
    }

    return res.status(200).json({ success: true, messagesSent, date: today });
  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
