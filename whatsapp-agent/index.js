const express = require('express');
const axios = require('axios');
const path = require('path');

/* =========================================================
   CRASH & ERROR HANDLERS
========================================================= */

process.on('uncaughtException', function(err) {

  console.error('================================');
  console.error('❌ UNCAUGHT EXCEPTION');
  console.error(err);
  console.error('================================');

});

process.on('unhandledRejection', function(reason) {

  console.error('================================');
  console.error('❌ UNHANDLED REJECTION');
  console.error(reason);
  console.error('================================');

});

/* =========================================================
   APP INIT
========================================================= */

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname)));

console.log('🚀 Starting Phoenix WhatsApp Agent...');

const SUPABASE_URL = 'https://sainjerowmjetpmtezwg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';
const GROQ_KEY = process.env.GROQ_API_KEY;

/* =========================================================
   ENV CHECKS
========================================================= */

console.log('✅ SUPABASE_KEY:', SUPABASE_KEY ? 'Loaded' : 'Missing');
console.log('✅ WA_TOKEN:', WA_TOKEN ? 'Loaded' : 'Missing');
console.log('✅ WA_PHONE_ID:', WA_PHONE_ID ? 'Loaded' : 'Missing');
console.log('✅ VERIFY_TOKEN:', VERIFY_TOKEN ? 'Loaded' : 'Missing');
console.log('✅ GROQ_KEY:', GROQ_KEY ? 'Loaded' : 'Missing');

/* =========================================================
   SUPABASE
========================================================= */

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

/* =========================================================
   HELPERS
========================================================= */

var processedMessages = new Set();

function isDuplicate(msgId) {

  if (!msgId) return false;

  if (processedMessages.has(msgId)) {
    return true;
  }

  processedMessages.add(msgId);

  if (processedMessages.size > 1000) {
    processedMessages.delete(
      processedMessages.values().next().value
    );
  }

  return false;
}

function sleep(ms) {
  return new Promise(function(r) {
    setTimeout(r, ms);
  });
}

function splitMessage(text) {

  if (!text || text.length <= 4000) {
    return [text || ''];
  }

  var chunks = [];
  var t = text;

  while (t.length > 0) {

    var c = t.substring(0, 4000);

    chunks.push(c.trim());

    t = t.substring(c.length).trim();
  }

  return chunks;
}

/* =========================================================
   WA SEND
========================================================= */

async function sendText(phone, message) {

  try {

    var fp = phone.startsWith('+')
      ? phone
      : '+' + phone;

    var chunks = splitMessage(message);

    for (var i = 0; i < chunks.length; i++) {

      await axios.post(
        'https://graph.facebook.com/v18.0/' +
        WA_PHONE_ID +
        '/messages',

        {
          messaging_product: 'whatsapp',
          to: fp,
          type: 'text',
          text: {
            body: chunks[i]
          }
        },

        {
          headers: {
            Authorization: 'Bearer ' + WA_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      if (chunks.length > 1) {
        await sleep(600);
      }
    }

    await logOutbound(phone, message);

  } catch (e) {

    console.error('================ SEND ERROR ================');

    console.error(
      JSON.stringify(
        e.response ? e.response.data : e.message,
        null,
        2
      )
    );

    console.error('============================================');

  }
}

async function sendImage(phone, imageUrl, caption) {

  try {

    if (!imageUrl) return;

    var fp = phone.startsWith('+')
      ? phone
      : '+' + phone;

    await axios.post(
      'https://graph.facebook.com/v18.0/' +
      WA_PHONE_ID +
      '/messages',

      {
        messaging_product: 'whatsapp',
        to: fp,
        type: 'image',
        image: {
          link: imageUrl,
          caption: caption || ''
        }
      },

      {
        headers: {
          Authorization: 'Bearer ' + WA_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

  } catch (e) {

    console.error(
      'sendImage FAILED:',
      JSON.stringify(
        e.response
          ? e.response.data
          : e.message
      )
    );

  }
}

async function sendVideoAsLink(phone, youtubeId, caption) {

  try {

    if (!youtubeId) return;

    var msg =
      (caption ? caption + '\n' : '') +
      '🎥 https://www.youtube.com/watch?v=' +
      youtubeId;

    await sendText(phone, msg);

  } catch (e) {}
}

/* =========================================================
   SUPABASE
========================================================= */

async function getLead(phone) {

  try {

    var res = await supabase.get(
      '/rest/v1/wp_leads?phone=eq.' +
      encodeURIComponent(phone) +
      '&select=*'
    );

    return res.data && res.data[0]
      ? res.data[0]
      : null;

  } catch (e) {

    console.error('getLead:', e.message);

    return null;
  }
}

async function upsertLead(phone, name, fields) {

  try {

    var existing = await getLead(phone);

    var now = new Date().toISOString();

    var topLevel = [
      'name',
      'phone',
      'email',
      'status',
      'event_type',
      'package_type',
      'urgency_level',
      'lead_score',
      'source_channel',
      'last_message',
      'tags'
    ];

    var topFields = {};
    var metaFields = {};

    Object.keys(fields || {}).forEach(function(k) {

      if (topLevel.indexOf(k) !== -1) {
        topFields[k] = fields[k];
      } else {
        metaFields[k] = fields[k];
      }

    });

    if (!existing) {

      var payload = Object.assign({

        phone: phone,
        name: name || 'Friend',
        status: 'new',
        source_channel: 'whatsapp',
        lead_score: 0,
        created_at: now,
        updated_at: now

      }, topFields);

      if (Object.keys(metaFields).length > 0) {
        payload.metadata = metaFields;
      }

      await supabase.post(
        '/rest/v1/wp_leads',
        payload
      );

      console.log('New wp_lead:', phone);

    } else {

      var update = Object.assign({
        updated_at: now
      }, topFields);

      if (Object.keys(metaFields).length > 0) {

        update.metadata = Object.assign(
          {},
          existing.metadata || {},
          metaFields
        );

      }

      if (
        name &&
        name !== 'Friend' &&
        name !== 'Unknown' &&
        !existing.name
      ) {
        update.name = name;
      }

      if (existing.status === 'converted') {
        delete update.status;
      }

      await supabase.patch(
        '/rest/v1/wp_leads?phone=eq.' +
        encodeURIComponent(phone),
        update
      );
    }

  } catch (e) {

    console.error('upsertLead:', e.message);

  }
}

async function incrementLeadScore(phone, amount) {

  try {

    var lead = await getLead(phone);

    if (lead) {

      await supabase.patch(
        '/rest/v1/wp_leads?phone=eq.' +
        encodeURIComponent(phone),

        {
          lead_score:
            (lead.lead_score || 0) + amount,

          updated_at:
            new Date().toISOString()
        }
      );
    }

  } catch (e) {}
}

async function getConversationHistory(phone) {

  try {

    var res = await supabase.get(
      '/rest/v1/wp_conversations?lead_phone=eq.' +
      encodeURIComponent(phone) +
      '&order=created_at.desc&limit=20&select=direction,message,created_at'
    );

    if (!res.data || res.data.length === 0) {
      return [];
    }

    return res.data.reverse();

  } catch (e) {

    return [];
  }
}

async function logInbound(phone, message, msgId) {

  try {

    var lead = await getLead(phone);

    await supabase.post(
      '/rest/v1/wp_conversations',

      {
        lead_id:
          lead
            ? lead.id
            : null,

        lead_phone: phone,
        direction: 'inbound',
        message: message,
        message_type: 'text',

        metadata:
          msgId
            ? {
                whatsapp_message_id: msgId
              }
            : {}
      }
    );

  } catch (e) {}
}

async function logOutbound(phone, message) {

  try {

    var lead = await getLead(phone);

    await supabase.post(
      '/rest/v1/wp_conversations',

      {
        lead_id:
          lead
            ? lead.id
            : null,

        lead_phone: phone,
        direction: 'outbound',
        message: message,
        message_type: 'text'
      }
    );

  } catch (e) {}
}

/* =========================================================
   PRIVACY POLICY
========================================================= */

app.get('/privacy-policy', function(req, res) {

  res.sendFile(
    path.join(
      __dirname,
      'privacy-policy.html'
    )
  );

});

/* =========================================================
   ROOT ROUTE
========================================================= */

app.get('/', function(req, res) {

  console.log('🏠 Root route ping');

  res.json({
    status: 'Phoenix WhatsApp AI Agent VERSION 9',
    timestamp: new Date().toISOString()
  });

});

/* =========================================================
   HEALTH
========================================================= */

app.get('/health', function(req, res) {

  console.log('💚 Health check ping');

  res.status(200).json({
    success: true,
    service: 'running',
    timestamp: new Date().toISOString()
  });

});

/* =========================================================
   WEBHOOK VERIFY
========================================================= */

app.get('/whatsapp', function(req, res) {

  console.log('📩 Webhook verification request received');

  var mode = req.query['hub.mode'];

  var token =
    req.query['hub.verify_token'];

  var challenge =
    req.query['hub.challenge'];

  console.log('Mode:', mode);
  console.log('Token:', token);

  if (
    mode === 'subscribe' &&
    token === VERIFY_TOKEN
  ) {

    console.log(
      '✅ WEBHOOK VERIFIED SUCCESSFULLY'
    );

    return res
      .status(200)
      .send(challenge);
  }

  console.log(
    '❌ WEBHOOK VERIFICATION FAILED'
  );

  return res.sendStatus(403);
});

/* =========================================================
   WHATSAPP WEBHOOK
========================================================= */

app.post('/whatsapp', async function(req, res) {

  try {

    var body = req.body;

    console.log(
      '📨 Incoming webhook event'
    );

    console.log(
      JSON.stringify(body, null, 2)
    );

    res.sendStatus(200);

    if (
      !body.object ||
      body.object !==
      'whatsapp_business_account'
    ) {
      return;
    }

    var entry =
      body.entry &&
      body.entry[0];

    var changes =
      entry &&
      entry.changes &&
      entry.changes[0];

    var value =
      changes &&
      changes.value;

    var messages =
      value &&
      value.messages;

    if (!messages || !messages[0]) {
      return;
    }

    var msg = messages[0];

    if (
      msg.type !== 'text' &&
      msg.type !== 'interactive' &&
      msg.type !== 'button'
    ) {
      return;
    }

    var msgId = msg.id;

    if (isDuplicate(msgId)) {
      return;
    }

    var phone = msg.from;

    var contacts =
      value.contacts || [];

    var name =
      (
        contacts[0] &&
        contacts[0].profile &&
        contacts[0].profile.name
      ) || 'Friend';

    var messageText =
      (
        msg.text &&
        msg.text.body
      ) ||

      (
        msg.interactive &&
        msg.interactive.list_reply &&
        msg.interactive.list_reply.title
      ) ||

      (
        msg.interactive &&
        msg.interactive.button_reply &&
        msg.interactive.button_reply.title
      ) ||

      (
        msg.button &&
        msg.button.text
      ) ||

      '';

    if (!messageText.trim()) {
      return;
    }

    console.log(
      'Incoming | Phone:',
      phone,
      '| Name:',
      name,
      '| Msg:',
      messageText.substring(0, 60)
    );

    handleMessage(
      phone,
      messageText,
      name,
      msgId
    ).catch(function(e) {

      console.error(
        'handleMessage error:',
        e.message
      );

    });

  } catch (e) {

    console.error(
      'Webhook error:',
      e.message
    );

  }
});

/* =========================================================
   SERVER START
========================================================= */

var PORT = process.env.PORT || 3000;

var server = app.listen(
  PORT,
  '0.0.0.0',
  function() {

    console.log('================================');
    console.log('🚀 Phoenix WhatsApp AI Agent VERSION 9');
    console.log('🌐 Running on port ' + PORT);
    console.log('🔗 https://whatsapp-agentindexjs-production.up.railway.app');
    console.log('================================');

  }
);

server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
