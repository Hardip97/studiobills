import twilio from 'twilio';

export default async function handler(req, res) {
  // Allow GET requests since Vercel Cron uses GET by default, but also allow POST just in case.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Optional: Verify the request is actually from Vercel Cron
  // using req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`

  try {
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    const twilioPhone = process.env.TWILIO_WHATSAPP_NUMBER || '+14155238886'; // default sandbox

    // Helper to fetch from Supabase
    async function supaFetch(path, method = 'GET') {
      const url  = `${process.env.SUPABASE_URL}${path}`;
      const opts = {
        method,
        headers: {
          'apikey':        process.env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type':  'application/json',
        },
      };
      const resp = await fetch(url, opts);
      if (!resp.ok) return null;
      try { return await resp.json(); } catch { return null; }
    }

    // 1. Fetch all users
    const usersRows = await supaFetch('/rest/v1/user_data?select=user_id,data');
    if (!usersRows) {
      return res.status(500).json({ error: 'Internal error connecting to database.' });
    }

    const today = new Date().toISOString().split('T')[0];
    
    // Calculate tomorrow
    const tDate = new Date();
    tDate.setDate(tDate.getDate() + 1);
    const tomorrow = tDate.toISOString().split('T')[0];

    let messagesSent = 0;

    // 2. Iterate users and find reminders
    for (const row of usersRows) {
      const data = row.data || {};
      const profile = data.profile || {};
      const calendar = data.calendar || [];
      
      if (!profile.whatsapp) continue; // Skip if no WhatsApp number linked
      
      const userWhatsApp = `whatsapp:${profile.whatsapp.startsWith('+') ? profile.whatsapp : '+' + profile.whatsapp}`;

      const upcomingTasks = calendar.filter(task => {
        // Only remind for tasks that are not done and are either today or tomorrow
        return !task.done && (task.date === today || task.date === tomorrow);
      });

      if (upcomingTasks.length > 0) {
        // Build the message
        let msg = `📅 *StudioBills Reminders*\n\nYou have ${upcomingTasks.length} upcoming task(s):\n\n`;
        
        upcomingTasks.forEach(task => {
          const dayLabel = task.date === today ? 'Today' : 'Tomorrow';
          const timeLabel = task.time ? ` at ${task.time}` : '';
          msg += `• *${task.title}* (${dayLabel}${timeLabel})\n`;
          if (task.note) msg += `  📝 ${task.note}\n`;
        });
        
        msg += `\nReply with 'Expense <amount> <category>' to add expenses directly!`;

        // Send WhatsApp message
        try {
          await twilioClient.messages.create({
            body: msg,
            from: `whatsapp:${twilioPhone.replace('whatsapp:', '')}`,
            to: userWhatsApp
          });
          messagesSent++;
        } catch (twErr) {
          console.error(`Failed to send to ${userWhatsApp}:`, twErr.message);
        }
      }
    }

    return res.status(200).json({ success: true, messagesSent });

  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}
