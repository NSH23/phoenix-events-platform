const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const SUPABASE_URL = 'https://qjxqebtxhfwaufmccewj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID || '1023140200877702';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'phoenix_verify_2024';
const GROQ_KEY = process.env.GROQ_API_KEY;

const supabase = axios.create({
  baseURL: SUPABASE_URL,
  headers: {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  }
});

var processedMessages = new Set();
function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.add(msgId);
  if (processedMessages.size > 1000) processedMessages.delete(processedMessages.values().next().value);
  return false;
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function splitMessage(text) {
  if (!text || text.length <= 4000) return [text || ''];
  var chunks = []; var t = text;
  while (t.length > 0) { var c = t.substring(0, 4000); chunks.push(c.trim()); t = t.substring(c.length).trim(); }
  return chunks;
}

async function sendText(phone, message) {
  try {
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    var chunks = splitMessage(message);
    for (var i = 0; i < chunks.length; i++) {
      await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
        { messaging_product: 'whatsapp', to: fp, type: 'text', text: { body: chunks[i] } },
        { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
      );
      if (chunks.length > 1) await sleep(600);
    }
    await logOutbound(phone, message);
  } catch (e) { console.error('sendText FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendImage(phone, imageUrl, caption) {
  try {
    if (!imageUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'image', image: { link: imageUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('sendImage FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function sendVideo(phone, videoUrl, caption) {
  try {
    if (!videoUrl) return;
    var fp = phone.startsWith('+') ? phone : '+' + phone;
    await axios.post('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages',
      { messaging_product: 'whatsapp', to: fp, type: 'video', video: { link: videoUrl, caption: caption || '' } },
      { headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' } }
    );
  } catch (e) { console.error('sendVideo FAILED:', JSON.stringify(e.response ? e.response.data : e.message)); }
}

async function getLead(phone) {
  try {
    var res = await supabase.get('/rest/v1/leads?phone=eq.' + phone + '&select=*');
    return res.data && res.data[0] ? res.data[0] : null;
  } catch (e) { return null; }
}

async function upsertLead(phone, name, fields) {
  try {
    var existing = await getLead(phone);
    var now = new Date().toISOString();
    if (!existing) {
      var payload = Object.assign({
        phone: phone, name: name || 'Friend', status: 'new', step: 'ai_chat',
        source: fields && fields.source ? fields.source : 'whatsapp',
        first_channel: 'whatsapp', last_channel: 'whatsapp',
        whatsapp_count: 1, call_count: 0, lead_score: 0,
        last_interaction: now, created_at: now
      }, fields || {});
      await supabase.post('/rest/v1/leads', payload);
    } else {
      var update = Object.assign({
        last_interaction: now, last_channel: 'whatsapp',
        whatsapp_count: (existing.whatsapp_count || 0) + 1, updated_at: now
      }, fields || {});
      if (name && name !== 'Friend' && name !== 'Unknown' && !existing.name) update.name = name;
      if (existing.status === 'qualified' || existing.status === 'converted') delete update.status;
      await supabase.patch('/rest/v1/leads?phone=eq.' + phone, update);
    }
  } catch (e) { console.error('upsertLead:', e.message); }
}

async function incrementLeadScore(phone, amount) {
  try {
    var lead = await getLead(phone);
    if (lead) await supabase.patch('/rest/v1/leads?phone=eq.' + phone, { lead_score: (lead.lead_score || 0) + amount });
  } catch (e) {}
}

async function getConversationHistory(phone) {
  try {
    var res = await supabase.get('/rest/v1/conversations?lead_phone=eq.' + phone + '&channel=eq.whatsapp&order=created_at.desc&limit=20&select=direction,content,created_at');
    if (!res.data || res.data.length === 0) return [];
    return res.data.reverse();
  } catch (e) { return []; }
}

async function logInbound(phone, message, msgId) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'inbound', message_type: 'text',
      content: message, whatsapp_message_id: msgId || '', status: 'received', channel: 'whatsapp'
    }, { headers: { Prefer: 'resolution=ignore-duplicates' } });
  } catch (e) {}
}

async function logOutbound(phone, message) {
  try {
    await supabase.post('/rest/v1/conversations', {
      lead_phone: phone, direction: 'outbound', message_type: 'text',
      content: message, status: 'sent', channel: 'whatsapp'
    });
  } catch (e) {}
}

async function getKnowledgeBase() {
  try {
    var res = await supabase.get('/rest/v1/knowledge_base?is_active=eq.true&select=category,title,content&order=category.asc');
    return res.data || [];
  } catch (e) { return []; }
}

var VENUE_KEY_MAP = {
  'sky_blue_banquet_hall_image': 'venue_1', 'sky_blue_image': 'venue_1', 'skyblue_image': 'venue_1', 'venue_1_image': 'venue_1',
  'blue_water_banquet_hall_image': 'venue_2', 'blue_water_image': 'venue_2', 'bluewater_image': 'venue_2', 'venue_2_image': 'venue_2',
  'thopate_banquets_image': 'venue_3', 'thopate_image': 'venue_3', 'venue_3_image': 'venue_3',
  'ramkrishna_veg_banquet_image': 'venue_4', 'ramkrishna_image': 'venue_4', 'venue_4_image': 'venue_4',
  'shree_krishna_palace_image': 'venue_5', 'shree_krishna_image': 'venue_5', 'venue_5_image': 'venue_5',
  'raghunandan_ac_banquet_image': 'venue_6', 'raghunandan_image': 'venue_6', 'venue_6_image': 'venue_6',
  'rangoli_banquet_hall_image': 'venue_7', 'rangoli_image': 'venue_7', 'venue_7_image': 'venue_7',
  'shaadi_image': 'event_wedding', 'wedding_image': 'event_wedding', 'event_wedding_image': 'event_wedding',
  'birthday_image': 'event_birthday', 'bday_image': 'event_birthday', 'event_birthday_image': 'event_birthday',
  'engagement_image': 'event_engagement', 'event_engagement_image': 'event_engagement',
  'sangeet_image': 'event_sangeet', 'event_sangeet_image': 'event_sangeet',
  'haldi_image': 'event_haldi', 'event_haldi_image': 'event_haldi',
  'mehendi_image': 'event_mehendi', 'event_mehendi_image': 'event_mehendi',
  'anniversary_image': 'event_anniversary', 'event_anniversary_image': 'event_anniversary',
  'corporate_image': 'event_corporate', 'event_corporate_image': 'event_corporate'
};

async function getWorkflowUrl(contentKey) {
  try {
    var res = await supabase.get('/rest/v1/workflow_content?content_key=eq.' + encodeURIComponent(contentKey) + '&is_active=eq.true&select=text_content');
    if (res.data && res.data[0] && res.data[0].text_content) return res.data[0].text_content;
    return null;
  } catch (e) { console.error('getWorkflowUrl error:', e.message); return null; }
}

async function getMediaBundle(key) {
  try {
    var normalizedKey = key.toLowerCase().replace(/[\s-]+/g, '_');
    var canonical = VENUE_KEY_MAP[normalizedKey] || normalizedKey;
    console.log('Media lookup:', key, '→', canonical);
    var images = [];
    var videos = [];
    var mEvent = canonical.match(/^event_([a-z0-9_]+)$/);
    var mVenue = canonical.match(/^venue_(\d+)$/);
    if (mEvent) {
      var slug = mEvent[1];
      var ip = []; for (var i = 1; i <= 4; i++) ip.push(getWorkflowUrl('event_' + slug + '_image_' + i));
      var vp = []; for (var j = 1; j <= 2; j++) vp.push(getWorkflowUrl('event_' + slug + '_video_' + j));
      (await Promise.all(ip)).forEach(function(u) { if (u) images.push(u); });
      (await Promise.all(vp)).forEach(function(u) { if (u) videos.push(u); });
      return { images: images, videos: videos };
    }
    if (mVenue) {
      var idx = parseInt(mVenue[1], 10);
      if (!isNaN(idx)) {
        var vip = []; for (var ii = 1; ii <= 4; ii++) vip.push(getWorkflowUrl('venue_' + idx + '_image_' + ii));
        var vvp = []; for (var jj = 1; jj <= 2; jj++) vvp.push(getWorkflowUrl('venue_' + idx + '_video_' + jj));
        (await Promise.all(vip)).forEach(function(u) { if (u) images.push(u); });
        (await Promise.all(vvp)).forEach(function(u) { if (u) videos.push(u); });
        return { images: images, videos: videos };
      }
    }
    var single = await getWorkflowUrl(canonical);
    if (single) images.push(single);
    return { images: images, videos: videos };
  } catch (e) { console.error('getMediaBundle error:', e.message); return { images: [], videos: [] }; }
}

// Contextual captions based on key name
function getMediaCaption(key, index, isVideo) {
  var k = (key || '').toLowerCase();
  var pre = isVideo ? '🎥' : '📸';
  if (index > 0) return ''; // only first item gets caption
  if (k.includes('wedding') || k.includes('shaadi')) return pre + ' Hamare Wedding events — aisa banate hain hum! ✨';
  if (k.includes('birthday') || k.includes('bday')) return pre + ' Birthday party — itna sundar karte hain hum! 🎂';
  if (k.includes('engagement')) return pre + ' Engagement decoration — ekdum filmy feel! 💍';
  if (k.includes('sangeet')) return pre + ' Sangeet night — full entertainment! 🎵';
  if (k.includes('haldi')) return pre + ' Haldi decoration — rang-birangi aur traditional! 🌸';
  if (k.includes('mehendi')) return pre + ' Mehendi setup — bohot khoobsurat! 🎨';
  if (k.includes('anniversary')) return pre + ' Anniversary decoration — romantic aur special! 💝';
  if (k.includes('corporate')) return pre + ' Corporate event — professional aur impactful! 🏢';
  if (k.includes('venue_1') || k.includes('sky_blue')) return pre + ' Sky Blue Banquet Hall — hamare kaam ki jhalak ✨';
  if (k.includes('venue_2') || k.includes('blue_water')) return pre + ' Blue Water Banquet Hall — hamare kaam ki jhalak ✨';
  if (k.includes('venue_3') || k.includes('thopate')) return pre + ' Thopate Banquets — hamare kaam ki jhalak ✨';
  if (k.includes('venue_4') || k.includes('ramkrishna')) return pre + ' RamKrishna Veg Banquet — hamare kaam ki jhalak ✨';
  if (k.includes('venue_5') || k.includes('shree_krishna')) return pre + ' Shree Krishna Palace — hamare kaam ki jhalak ✨';
  if (k.includes('venue_6') || k.includes('raghunandan')) return pre + ' Raghunandan AC Banquet — hamare kaam ki jhalak ✨';
  if (k.includes('venue_7') || k.includes('rangoli')) return pre + ' Rangoli Banquet Hall — hamare kaam ki jhalak ✨';
  return pre + ' Phoenix Events — hamare kaam ki jhalak ✨';
}

function buildKnowledgeContext(kb) {
  if (!kb || kb.length === 0) return '';
  var grouped = {};
  kb.forEach(function(item) {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push('## ' + item.title + '\n' + item.content);
  });
  return Object.keys(grouped).map(function(cat) {
    return '### ' + cat.toUpperCase() + '\n' + grouped[cat].join('\n\n');
  }).join('\n\n');
}

function extractLeadData(aiText) {
  var updates = {};
  var patterns = {
    name: /\[LEAD:name=([^\]]+)\]/,
    event_type: /\[LEAD:event_type=([^\]]+)\]/,
    venue: /\[LEAD:venue=([^\]]+)\]/,
    guest_count: /\[LEAD:guest_count=([^\]]+)\]/,
    event_date: /\[LEAD:event_date=([^\]]+)\]/,
    status: /\[LEAD:status=([^\]]+)\]/,
    package_type: /\[LEAD:package_type=([^\]]+)\]/,
    services_needed: /\[LEAD:services=([^\]]+)\]/,
    theme: /\[LEAD:theme=([^\]]+)\]/,
    indoor_outdoor: /\[LEAD:indoor_outdoor=([^\]]+)\]/,
    email: /\[LEAD:email=([^\]]+)\]/,
    city: /\[LEAD:city=([^\]]+)\]/,
    source: /\[LEAD:source=([^\]]+)\]/,
    function_list: /\[LEAD:functions=([^\]]+)\]/,
    relationship_to_event: /\[LEAD:relationship=([^\]]+)\]/,
    preferred_call_time: /\[LEAD:call_time=([^\]]+)\]/,
    instagram_id: /\[LEAD:instagram=([^\]]+)\]/
  };
  for (var key in patterns) {
    var m = aiText.match(patterns[key]);
    if (m) {
      if (key === 'guest_count') { var n = parseInt(m[1]); if (!isNaN(n)) updates.guest_count = n; }
      else updates[key] = m[1].trim();
    }
  }
  var scoreMatch = aiText.match(/\[LEAD:score\+(\d+)\]/);
  if (scoreMatch) updates._scoreIncrement = parseInt(scoreMatch[1]);
  var imgMatch = aiText.match(/\[SEND:image=([^\]]+)\]/g);
  if (imgMatch) updates._sendImages = imgMatch.map(function(t) { return t.replace('[SEND:image=', '').replace(']', ''); });
  return updates;
}

function cleanAiTags(text) {
  return text.replace(/\[LEAD:[^\]]+\]/g, '').replace(/\[SEND:[^\]]+\]/g, '').trim();
}

var OUR_VENUE_KEYWORDS = ['sky blue', 'blue water', 'thopate', 'ramkrishna', 'ram krishna', 'shree krishna', 'raghunandan', 'rangoli'];
function isOurVenue(venueName) {
  if (!venueName) return false;
  var lower = String(venueName).toLowerCase();
  return OUR_VENUE_KEYWORDS.some(function(k) { return lower.indexOf(k) !== -1; });
}

async function callGroq(phone, userMessage, lead, history, knowledgeBase) {
  var kb = buildKnowledgeContext(knowledgeBase);
  var alreadyKnow = [];
  var missing = [];
  var venueIsOurs = false;

  if (lead) {
    var hasName = lead.name && lead.name !== 'Friend' && lead.name !== 'Guest' && lead.name !== 'Unknown';
    if (hasName) alreadyKnow.push('Naam: ' + lead.name); else missing.push('naam');
    if (lead.event_type) alreadyKnow.push('Event type: ' + lead.event_type); else missing.push('event type');
    if (lead.event_date) alreadyKnow.push('Event date: ' + lead.event_date); else missing.push('event date');
    if (lead.guest_count) alreadyKnow.push('Guests: ' + lead.guest_count); else missing.push('guest count');
    if (lead.venue) { alreadyKnow.push('Venue: ' + lead.venue); venueIsOurs = isOurVenue(lead.venue); } else missing.push('venue');

    // Priority order: function_list → services_needed → indoor_outdoor → theme → city_area (only if not our venue) → package_type
    if (lead.function_list) alreadyKnow.push('Associated functions: ' + lead.function_list); else missing.push('function_list — "Wedding ke saath aur kya hoga? Mehendi, haldi, sangeet, reception?"');
    if (lead.services_needed) alreadyKnow.push('Services needed: ' + lead.services_needed); else missing.push('services_needed — "Kaun si services chahiye? Decoration, photography, videography, DJ, lighting, mandap?"');
    if (lead.indoor_outdoor) alreadyKnow.push('Indoor/Outdoor: ' + lead.indoor_outdoor); else missing.push('indoor_outdoor — "Event indoor hoga ya outdoor?"');
    if (lead.theme) alreadyKnow.push('Theme/colour: ' + lead.theme); else missing.push('theme — "Koi specific theme ya colour scheme hai?"');
    if (!venueIsOurs) {
      if (lead.city) alreadyKnow.push('City/Area: ' + lead.city);
      else missing.push('city_area — "Aap kis area mein event karna chahte hain?" (SIRF isliye poocho kyunki venue hamare 7 partner venues mein se nahi hai)');
    } else {
      if (lead.city) alreadyKnow.push('City/Area: ' + lead.city);
    }
    if (lead.package_type) alreadyKnow.push('Package: ' + lead.package_type); else missing.push('package_type — "Budget ke hisaab se: simple, standard, premium ya luxury?"');
    if (lead.preferred_call_time) alreadyKnow.push('Preferred call time: ' + lead.preferred_call_time);
    if (lead.email) alreadyKnow.push('Email: ' + lead.email);
  }

  var voiceContext = '';
  if (lead && lead.call_count > 0) {
    voiceContext = '\n\nVOICE CALL CONTEXT (BAHUT IMPORTANT):\n';
    voiceContext += 'Is user se pehle ek voice call hua hai. Ab user WhatsApp pe message kar raha/rahi hai — SAME Aishwarya ho tum, conversation continue ho rahi hai.\n';
    if (lead.call_summary && lead.call_summary.trim()) voiceContext += 'Call summary: ' + lead.call_summary + '\n';
    if (lead.last_voice_transcript && lead.last_voice_transcript.trim()) voiceContext += 'Call transcript (partial): ' + lead.last_voice_transcript.substring(0, 800) + '\n';
    voiceContext += '\nCall continuation rules:\n';
    voiceContext += '- Call mein jo baat hui uska reference do naturally\n';
    voiceContext += '- Jo data call pe collect hua woh DOBARA mat maango\n';
    voiceContext += '- Sirf jo missing hai woh naturally poocho\n';
  } else if (lead && lead.whatsapp_count > 0) {
    voiceContext = '\n\nRETURNING WA USER: Pehle WhatsApp pe baat ho chuki hai. Warmly continue karo.';
  }

  var allCollected = missing.length === 0;

  var leadContext = lead
    ? 'CUSTOMER KE BAARE MEIN JO PATA HAI:\n' +
      (alreadyKnow.length ? alreadyKnow.join('\n') : 'Kuch nahi pata abhi') +
      '\n\nJO MISSING HAI (PRIORITY ORDER MEIN — EK-EK KARKE COLLECT KARO):\n' +
      (allCollected ? 'SAARA DATA MIL GAYA! Support mode mein raho — aur koi naya sawaal nahi.' : missing.map(function(m, i) { return (i + 1) + '. ' + m; }).join('\n')) +
      '\n\nJO PEHLE SE PATA HAI WOH BILKUL MAT POOCHO.' + voiceContext
    : 'NAYA CUSTOMER — pehli baar baat ho rahi hai. Priority mein collect karo: naam, event type, event date, guest count, venue, function_list, services_needed, indoor_outdoor, theme, package_type.';

  var systemPrompt =
    'Tu Aishwarya hai — Phoenix Events & Production ki WhatsApp assistant, Pimpri-Chinchwad, Pune se.\n\n' +
    'LANGUAGE: HAMESHA SIRF HINDI MEIN BAAT KAR. Hinglish (Roman script) ya Devanagari dono theek hai. KABHI English ya Marathi mein reply mat kar.\n\n' +
    'PERSONALITY:\n' +
    '- Warm, bubbly, genuine — jaise ek helpful saheli\n' +
    '- Real insaan ki tarah — kabhi robotic mat lag\n' +
    '- HAMESHA female words: bataungi, karungi, hoon, rahi hoon — KABHI bataunga/karunga nahi\n' +
    '- User ko "aap" bolna\n' +
    '- Natural reactions: "Wah!", "Acha!", "Bahut sahi!" — sirf jab genuinely fit ho\n\n' +
    'RESPONSE STYLE:\n' +
    '- 2-3 lines max — short, warm, conversational\n' +
    '- EK HI SAWAAL ek response mein — KABHI do sawaal ek saath nahi\n' +
    '- *bold* important cheezein, emojis natural jagah pe\n\n' +
    'CUSTOMER STATUS:\n' + leadContext + '\n\n' +
    'KNOWLEDGE BASE:\n' + kb + '\n\n' +
    'COMPANY INFO:\n' +
    'Phoenix Events & Production | Pimpri-Chinchwad, Pune\n' +
    'Founded 2017 by Kevin | 500+ events | 98% client satisfaction\n' +
    'Website: phoenixeventsandproduction.com | Instagram: @phoenix_events_and_production | Call: +91 80357 35856\n\n' +
    'PARTNER VENUES (7):\n' +
    '1. Sky Blue Banquet Hall — Punawale/Ravet ⭐4.7 | 100-500 guests\n' +
    '2. Blue Water Banquet Hall — Punawale ⭐5.0 | 50-300 guests\n' +
    '3. Thopate Banquets — Rahatani | 100-400 guests\n' +
    '4. RamKrishna Veg Banquet — Ravet ⭐4.4 | 50-250 guests (veg only)\n' +
    '5. Shree Krishna Palace — Pimpri Colony ⭐4.3 | 100-600 guests\n' +
    '6. Raghunandan AC Banquet — Tathawade ⭐4.0 | 100-350 guests\n' +
    '7. Rangoli Banquet Hall — Chinchwad ⭐4.3 | 100-500 guests\n\n' +
    'DATA COLLECTION RULES:\n' +
    '- Jo pehle se pata hai WOH DOBARA MAT POOCHO — kabhi nahi\n' +
    '- EK RESPONSE MEIN SIRF EK SAWAAL\n' +
    '- Missing fields priority order mein collect karo (list mein jo pehle hai woh pehle poocho)\n' +
    '- Sawaal naturally weave karo — form ki tarah nahi\n' +
    '- User kuch aur pooche → pehle uska jawab do, PHIR ek missing sawaal naturally poocho\n' +
    '- city_area SIRF tab poocho jab venue hamare 7 partner venues mein se nahi hai\n' +
    '- Jab sare fields collect ho jaayein → sirf support mode, koi naya sawaal nahi\n\n' +
    'SUMMARY RULE: KABHI apne aap summary mat bhejo. SIRF tab bhejo jab user specifically maange.\n\n' +
    'SPECIALIST RULE: KABHI "main call karungi" mat bolna. HAMESHA "hamare specialist call karenge" bolna.\n\n' +
    'IMAGES BHEJO (exact keys):\n' +
    'Events: [SEND:image=event_wedding_image], [SEND:image=event_birthday_image], [SEND:image=event_engagement_image],\n' +
    '[SEND:image=event_sangeet_image], [SEND:image=event_haldi_image], [SEND:image=event_mehendi_image],\n' +
    '[SEND:image=event_anniversary_image], [SEND:image=event_corporate_image]\n' +
    'Venues: [SEND:image=venue_1_image] through [SEND:image=venue_7_image]\n' +
    'User photos/videos maange → turant bhejo. Event change ho → us event ki images bhejo. KABHI apni key mat banao.\n\n' +
    'STRICT RULES:\n' +
    '- Sirf Phoenix Events topics\n' +
    '- Price kabhi nahi — "Exact pricing ke liye hamare specialist se baat karein"\n' +
    '- Disrespect: ek baar warn, dobara ho toh khatam\n\n' +
    'DATA TAGS (message ke END mein):\n' +
    '[LEAD:name=] [LEAD:event_type=] [LEAD:venue=] [LEAD:guest_count=] [LEAD:event_date=]\n' +
    '[LEAD:package_type=] [LEAD:services=] [LEAD:theme=] [LEAD:indoor_outdoor=]\n' +
    '[LEAD:email=] [LEAD:city=] [LEAD:functions=] [LEAD:relationship=] [LEAD:call_time=]\n' +
    '[LEAD:status=qualified] [LEAD:score+5]';

  var messages = [];
  history.forEach(function(h) {
    messages.push({ role: h.direction === 'inbound' ? 'user' : 'assistant', content: h.content });
  });
  messages.push({ role: 'user', content: userMessage });

  try {
    var response = await axios.post('https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', max_tokens: 350, temperature: 0.5, messages: [{ role: 'system', content: systemPrompt }].concat(messages) },
      { headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' } }
    );
    var fullText = response.data.choices[0].message.content;
    console.log('Groq response:', fullText.substring(0, 150));
    return fullText;
  } catch (err) {
    console.error('Groq error:', JSON.stringify(err.response ? err.response.data : err.message));
    return 'Ek second, thodi technical dikkat aa gayi. Kripya dobara try karein ya humein call karein: +91 80357 35856 🙏';
  }
}

async function handleMessage(phone, userMessage, name, msgId) {
  console.log('Message from:', phone, '| text:', userMessage.substring(0, 60));
  await logInbound(phone, userMessage, msgId);

  var [lead, history, knowledgeBase] = await Promise.all([getLead(phone), getConversationHistory(phone), getKnowledgeBase()]);
  await upsertLead(phone, name, {});

  var aiResponse = await callGroq(phone, userMessage, lead, history, knowledgeBase);
  var extracted = extractLeadData(aiResponse);
  var imagesToSend = extracted._sendImages || [];
  var scoreIncrement = extracted._scoreIncrement || 0;
  delete extracted._sendImages;
  delete extracted._scoreIncrement;

  var cleanResponse = cleanAiTags(aiResponse);
  await sendText(phone, cleanResponse);

  // Send all media bundles with contextual captions
  for (var i = 0; i < imagesToSend.length; i++) {
    try {
      var bundle = await getMediaBundle(imagesToSend[i]);
      for (var ii = 0; ii < bundle.images.length; ii++) {
        await sleep(600);
        await sendImage(phone, bundle.images[ii], getMediaCaption(imagesToSend[i], ii, false));
      }
      for (var jj = 0; jj < bundle.videos.length; jj++) {
        await sleep(800);
        await sendVideo(phone, bundle.videos[jj], getMediaCaption(imagesToSend[i], jj, true));
      }
    } catch (e) { console.error('media send error:', e.message); }
  }

  if (extracted.venue) { extracted.venue_name = extracted.venue; delete extracted.venue; }

  if (extracted.event_date) {
    try {
      var parts = extracted.event_date.split('/');
      if (parts.length === 3) {
        var days = Math.floor((new Date(parts[2], parts[1] - 1, parts[0]) - new Date()) / 86400000);
        extracted.urgency_level = days <= 30 ? 'high' : days <= 90 ? 'medium' : 'low';
      }
    } catch (e) {}
  }

  if (Object.keys(extracted).length > 0) {
    var safeExtracted = Object.assign({}, extracted);
    delete safeExtracted.venue_name;
    var validFields = ['name','event_type','event_date','guest_count','venue','status','package_type',
      'services_needed','theme','indoor_outdoor','email','city','source','function_list',
      'relationship_to_event','preferred_call_time','instagram_id','urgency_level','callback_date','callback_time'];
    var filteredExtracted = {};
    Object.keys(safeExtracted).forEach(function(k) {
      if (validFields.indexOf(k) !== -1) filteredExtracted[k] = safeExtracted[k];
    });
    if (Object.keys(filteredExtracted).length > 0) {
      await upsertLead(phone, filteredExtracted.name || name, filteredExtracted);
    }
  }
  if (scoreIncrement) await incrementLeadScore(phone, scoreIncrement);
}

app.get('/whatsapp', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('Webhook verified'); res.status(200).send(challenge); }
  else res.sendStatus(403);
});

app.post('/whatsapp', async function(req, res) {
  try {
    var body = req.body;
    res.sendStatus(200);
    if (!body.object || body.object !== 'whatsapp_business_account') return;
    var entry = body.entry && body.entry[0];
    var changes = entry && entry.changes && entry.changes[0];
    var value = changes && changes.value;
    var messages = value && value.messages;
    if (!messages || !messages[0]) return;
    var msg = messages[0];
    if (msg.type !== 'text' && msg.type !== 'interactive' && msg.type !== 'button') return;
    var msgId = msg.id;
    if (isDuplicate(msgId)) { console.log('Duplicate dropped:', msgId); return; }
    var phone = msg.from;
    var contacts = value.contacts || [];
    var name = (contacts[0] && contacts[0].profile && contacts[0].profile.name) || 'Friend';
    var messageText =
      (msg.text && msg.text.body) ||
      (msg.interactive && msg.interactive.list_reply && msg.interactive.list_reply.title) ||
      (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) ||
      (msg.button && msg.button.text) || '';
    if (!messageText.trim()) return;
    console.log('Incoming | Phone:', phone, '| Name:', name, '| Msg:', messageText.substring(0, 60));
    handleMessage(phone, messageText, name, msgId).catch(function(e) { console.error('handleMessage error:', e.message); });
  } catch (e) { console.error('Webhook error:', e.message); }
});

app.get('/', function(req, res) {
  res.json({ status: 'Phoenix WhatsApp AI Agent VERSION 6', timestamp: new Date().toISOString() });
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Phoenix WhatsApp AI Agent VERSION 6 running on port ' + PORT); });
