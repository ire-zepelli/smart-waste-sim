/* Zura — smart waste bins, station 01 front end.
 *
 * Surfaces:
 *   station   the three bins with live fill and lock state. Tap one to scan.
 *   scan      a modal holding that bin's camera. Classifies, publishes on MQTT.
 *   circuit   the Wokwi board itself, plus per-bin telemetry and raw traffic.
 *
 * Fill level, gas and lock state are never invented here. They arrive as
 * telemetry from the ESP32 and go stale after STALE_MS rather than showing an
 * old number as though it were live.
 *
 * The one exception is the open/placed narration in the scan modal, which also
 * runs on the page's own ACCEPT so the sequence plays during a UI-only
 * demonstration. When the controller is running its ACCEPT event restarts it,
 * re-syncing to the lid that actually moved.
 *
 * Four swappable classifiers, chosen at runtime:
 *
 *   groq       Cloud vision, the default. qwen/qwen3.8-27b. Verified against
 *              the live API: api.groq.com sends access-control-allow-origin:*
 *              so the browser calls it directly, no proxy. Do NOT move this to
 *              qwen3.6-27b — that model fails JSON validation.
 *   gemini     Cloud vision. gemini-2.5-flash. Auth goes in ?key= because the
 *              x-goog-api-key header triggers a CORS preflight this endpoint
 *              refuses. Free tier is 5-15 requests/minute.
 *   teachable  Teachable Machine model in ./model/. Runs offline at ~5fps.
 *              This is the demo-safe fallback when the network dies.
 *   mobilenet  Stock ImageNet plus a crude keyword map. Present only so the
 *              page does something before the others are configured, and
 *              labelled untrained in the UI so it cannot be mistaken for real.
 *
 * Both cloud providers are on-demand: every scan is a metered API call, so it
 * fires on the button and never on a timer. Keys are entered at runtime and
 * held in localStorage, stored per provider so switching cannot send one
 * provider's key to the other. No key is ever written to a file here.
 */

const BINS = ['BIODEGRADABLE', 'RECYCLABLE', 'NON_RECYCLABLE'];

const META = {
  BIODEGRADABLE:  {
    short: 'BIO', key: 'bio', name: 'Biodegradable',
    iconSvg: `<svg class="binIconSvg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="#000000" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M32 58V10"/>
        <path d="M32 20C32 20 20 12 12 18C12 28 22 32 32 32"/>
        <path d="M32 20C32 20 44 12 52 18C52 28 42 32 32 32"/>
        <path d="M32 32C32 32 22 26 14 30C14 38 22 42 32 42"/>
        <path d="M32 32C32 32 42 26 50 30C50 38 42 42 32 42"/>
        <path d="M32 10C32 10 24 4 18 8C18 15 25 18 32 18"/>
        <path d="M32 10C32 10 40 4 46 8C46 15 39 18 32 18"/>
      </g>
      <g stroke="#4ade80" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" fill="none">
        <path d="M32 58V10"/>
        <path d="M32 20C32 20 20 12 12 18C12 28 22 32 32 32"/>
        <path d="M32 20C32 20 44 12 52 18C52 28 42 32 32 32"/>
        <path d="M32 32C32 32 22 26 14 30C14 38 22 42 32 42"/>
        <path d="M32 32C32 32 42 26 50 30C50 38 42 42 32 42"/>
        <path d="M32 10C32 10 24 4 18 8C18 15 25 18 32 18"/>
        <path d="M32 10C32 10 40 4 46 8C46 15 39 18 32 18"/>
      </g>
    </svg>`,
    icon: '🌿', hint: 'Food scraps, peel, garden waste'
  },
  RECYCLABLE:     {
    short: 'REC', key: 'rec', name: 'Recyclable',
    iconSvg: `<svg class="binIconSvg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g stroke="#000000" stroke-width="11.0" fill="none"
         stroke-linecap="round" stroke-linejoin="round">
        <g transform="rotate(0 32 32)"><path d="M34.55 15.41 L45.82 34.94"/><path d="M40.19 38.19 L50.00 42.19 L51.45 31.69 Z" fill="#000000" stroke-linejoin="round"/></g>
        <g transform="rotate(120 32 32)"><path d="M34.55 15.41 L45.82 34.94"/><path d="M40.19 38.19 L50.00 42.19 L51.45 31.69 Z" fill="#000000" stroke-linejoin="round"/></g>
        <g transform="rotate(240 32 32)"><path d="M34.55 15.41 L45.82 34.94"/><path d="M40.19 38.19 L50.00 42.19 L51.45 31.69 Z" fill="#000000" stroke-linejoin="round"/></g>
      </g>
      <g stroke="#38bdf8" stroke-width="6.0" fill="none"
         stroke-linecap="round" stroke-linejoin="round">
        <g transform="rotate(0 32 32)"><path d="M34.55 15.41 L45.82 34.94"/><path d="M40.19 38.19 L50.00 42.19 L51.45 31.69 Z" fill="#38bdf8" stroke-linejoin="round"/></g>
        <g transform="rotate(120 32 32)"><path d="M34.55 15.41 L45.82 34.94"/><path d="M40.19 38.19 L50.00 42.19 L51.45 31.69 Z" fill="#38bdf8" stroke-linejoin="round"/></g>
        <g transform="rotate(240 32 32)"><path d="M34.55 15.41 L45.82 34.94"/><path d="M40.19 38.19 L50.00 42.19 L51.45 31.69 Z" fill="#38bdf8" stroke-linejoin="round"/></g>
      </g>
    </svg>`,
    icon: '♻️', hint: 'Bottles, cans, clean paper, glass'
  },
  NON_RECYCLABLE: {
    short: 'NON', key: 'non', name: 'Non-Recyclable',
    iconSvg: `<svg class="binIconSvg" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="22" fill="#ffffff" stroke="#000000" stroke-width="7"/>
      <circle cx="32" cy="32" r="22" stroke="#ea580c" stroke-width="5"/>
      <line x1="16" y1="16" x2="48" y2="48" stroke="#000000" stroke-width="8"/>
      <line x1="16" y1="16" x2="48" y2="48" stroke="#ea580c" stroke-width="5"/>
    </svg>`,
    icon: '🚫', hint: 'Sachets, styrofoam, nappies'
  },
};
const SHORT = Object.fromEntries(BINS.map((b) => [b, META[b].short]));
const BY_KEY = Object.fromEntries(BINS.map((b) => [META[b].key, b]));

/* Must stay identical to firmware/smart_bin.ino. */
const PINS = {
  bio: { trig: 13, echo: 34, servo: 33, red: 16, green: 17 },
  rec: { trig: 14, echo: 35, servo: 32, red: 18, green: 19 },
  non: { trig: 26, echo: 36, servo: 25, red: 21, green: 22 },
};
const WOKWI_LABEL = { 16: 'RX2', 17: 'TX2', 36: 'VP', 39: 'VN' };
const pinLabel = (n) => (WOKWI_LABEL[n] ? `${n}/${WOKWI_LABEL[n]}` : String(n));

const INFER_MS = 200;
const STABLE_MS = 1500;
const COOLDOWN_MS = 3000;
const STALE_MS = 15000;   // no telemetry for this long => grey the bin out
const LID_OPEN_MS = 2000; // mirrors the firmware's lid dwell
const MAX_SCAN_ATTEMPTS = 3;  // retries before a rejection is reported
const RETRY_GAP_MS = 350;     // spacing between retries, to be kind to rate limits
const PLACED_MS = 2000;        // how long "item placed" shows before the modal closes
const REJECT_CLOSE_MS = 4500;  // long enough to read the reason and still reach Override

const $ = (s) => document.querySelector(s);
const el = {
  cam: $('#cam'), camOverlay: $('#camOverlay'), startCam: $('#startCam'),
  stopCam: $('#stopCam'), camSelect: $('#camSelect'),
  bars: $('#bars'), verdict: $('#verdict'), verdictItem: $('#verdictItem'),
  present: $('#present'), autoPresent: $('#autoPresent'),
  log: $('#log'), clearLog: $('#clearLog'),
  modelPill: $('#modelPill'), mqttPill: $('#mqttPill'), stationPill: $('#stationPill'),
  binCards: $('#binCards'), circuitCards: $('#circuitCards'),
  scanModalOverlay: $('#scanModalOverlay'), scanModalCard: $('#scanModalCard'),
  scanModalIcon: $('#scanModalIcon'), scanModalTitle: $('#scanModalTitle'),
  scanModalSub: $('#scanModalSub'), closeScanModal: $('#closeScanModal'),
  scanStatusBadge: $('#scanStatusBadge'), scanModalHint: $('#scanModalHint'),
  scanResult: $('#scanResult'), scanResultLabel: $('#scanResultLabel'),
  cfgWokwiId: $('#cfgWokwiId'), wokwiFrame: $('#wokwiFrame'), wokwiOpen: $('#wokwiOpen'),
  totalSorted: $('#totalSorted'), statusDot: $('#statusDot'),
  helpBtn: $('#helpBtn'), helpPanel: $('#helpPanel'), helpClose: $('#helpClose'),
  cfgProvider: $('#cfgProvider'), cfgKey: $('#cfgKey'), cfgGeminiModel: $('#cfgGeminiModel'),
  cfgBroker: $('#cfgBroker'), cfgTopic: $('#cfgTopic'), cfgConf: $('#cfgConf'),
  reconnect: $('#reconnect'),
};

const state = {
  classifier: null,
  stream: null,
  targetBin: null,
  latest: [],
  note: null,
  scanError: null,   // surfaced in the modal, not just the hidden log
  lidEvent: null,    // {key, opensUntil} - narrates the lid cycle; PLACED persists
  closeTimer: null,  // auto-close once the outcome has been shown
  showResult: false, // outcome reached: camera and Scan Item give way to it
  serverKeys: {},    // providers serve.py holds a key for, from /api/status
  samples: {},       // corrections filed per label, from /api/samples
  sampleTotal: 0,
  canSaveSamples: true,
  busy: false,
  view: 'station',
  stableSince: 0,
  stableLabel: null,
  lastAutoPublish: 0,
  client: null,
  inferTimer: null,
  bins: Object.fromEntries(BINS.map((b) => [META[b].key, {
    fill: null, gas: null, status: null, lastSeen: 0,
    event: null, reason: null, eventAt: 0, lidOpenUntil: 0,
    collected: 0,   // accepted items, persisted in localStorage
    lastCountedAt: 0,
    overridden: 0,  // of those, admitted by human override
  }])),
};

/* ── logging ──────────────────────────────────────────────────────────── */

function log(msg, kind) {
  // The MQTT traffic panel was removed from the UI. Diagnostics still need to
  // go somewhere findable, so they go to the browser console.
  if (kind === 'err') console.warn('[zura]', msg); else console.log('[zura]', msg);
  if (!el.log) return;
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const m = document.createElement('span');
  m.className = 'm' + (kind ? ` m--${kind}` : '');
  m.textContent = msg;
  li.append(t, m);
  el.log.prepend(li);
  while (el.log.children.length > 150) el.log.lastChild.remove();
}

function pill(node, text, kind) {
  if (!node) return;   // status pills were removed from the circuit view
  node.textContent = text;
  node.className = `pill pill--${kind}`;
}

/* ── model providers ──────────────────────────────────────────────────── */

const IMAGENET_MAP = {
  BIODEGRADABLE: ['banana', 'orange', 'lemon', 'pineapple', 'strawberry', 'fig',
    'pomegranate', 'granny smith', 'corn', 'broccoli', 'cabbage', 'cauliflower',
    'mushroom', 'cucumber', 'zucchini', 'artichoke', 'bell pepper', 'acorn',
    'pizza', 'bagel', 'pretzel', 'cheeseburger', 'hotdog', 'burrito', 'meat loaf',
    'carbonara', 'guacamole', 'mashed potato', 'french loaf', 'dough', 'trifle',
    'ice cream', 'espresso', 'red wine', 'butternut squash', 'spaghetti'],
  RECYCLABLE: ['bottle', 'can', 'carton', 'paper', 'cardboard', 'box', 'jar',
    'glass', 'tin', 'container', 'envelope', 'newspaper', 'book', 'binder',
    'goblet', 'cup', 'coffee mug', 'tray', 'bucket', 'pail', 'milk can',
    'soap dispenser', 'water jug', 'vase', 'beaker', 'pitcher', 'thimble',
    'nail', 'screw', 'padlock', 'safety pin', 'spatula', 'ladle', 'wok', 'pan'],
  NON_RECYCLABLE: ['plastic bag', 'wrapper', 'packet', 'diaper', 'tissue',
    'paper towel', 'handkerchief', 'rubber', 'eraser', 'lighter', 'matchstick',
    'band aid', 'syringe', 'toothbrush', 'hair spray', 'lotion', 'sunscreen',
    'shoe', 'sandal', 'sock', 'mask', 'balloon', 'crayon', 'ballpoint',
    'lipstick', 'nipple', 'swab', 'broom', 'mop', 'velvet', 'wool'],
};

function normaliseLabel(raw) {
  const s = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (BINS.includes(s)) return s;
  if (/^(BIO|ORGANIC|COMPOST)/.test(s)) return 'BIODEGRADABLE';
  if (/^(REC|RECYCLE)/.test(s)) return 'RECYCLABLE';
  if (/^(NON|RESIDUAL|TRASH|GENERAL)/.test(s)) return 'NON_RECYCLABLE';
  return null;
}

function captureFrame(video, maxEdge = 640, quality = 0.85) {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality).split(',')[1];
}

const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    class: { type: 'string', enum: [...BINS, 'NO_MATCH'] },
    confidence: { type: 'number' },
    item: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['class', 'confidence', 'item', 'reason'],
};

const VISION_PROMPT = `You are the waste classification module of a smart segregation bin in the Philippines.

Identify the single most prominent waste item a person is holding up to the bin and classify it into exactly one category:

- BIODEGRADABLE: food scraps, fruit and vegetable peel, garden waste, soiled paper napkins, anything that will rot.
- RECYCLABLE: clean plastic bottles and containers, glass, metal cans, clean paper, cardboard.
- NON_RECYCLABLE: sachets and multilayer film, styrofoam, nappies, cigarette butts, broken ceramics, contaminated or mixed-material packaging.
- NO_MATCH: no clear waste item is being presented, the image is too blurred or dark, or you genuinely cannot tell.

Return NO_MATCH rather than guessing. Contamination downgrades an item: a grease-soaked pizza box is BIODEGRADABLE, not RECYCLABLE.

confidence must express ONE thing only: how sure you are of the CATEGORY. Anchor it:

- 0.90 to 1.00 - you can name the item and its material, and the category follows clearly.
- 0.70 to 0.89 - you are fairly sure of the category but the item is partly obscured or ambiguous.
- below 0.70 - you genuinely cannot tell. Use NO_MATCH instead.

Do NOT lower confidence because the photo is dark, blurred, crinkled or badly framed. Poor image quality only matters if it actually stops you identifying the item. If you can say what the object is and what it is made of, you are confident, however bad the picture looks.

item is a two-or-three word name for what you see. reason is one short sentence a student could read aloud during a demonstration.`;

/** Turn a cloud provider's {class, confidence, item, reason} into the internal
 *  prediction array, and stash the human-readable note for the UI. Shared so
 *  Gemini and Groq cannot drift apart in how they report a result. */
function shapePrediction(out) {
  const label = out.class === 'NO_MATCH' ? 'NO_MATCH' : (normaliseLabel(out.class) || 'NO_MATCH');
  const p = Math.max(0, Math.min(1, Number(out.confidence) || 0));
  state.note = out.item ? `${out.item} — ${out.reason || ''}`.trim() : (out.reason || null);
  const rest = BINS.filter((b) => b !== label);
  return [{ label, p }, ...rest.map((b) => ({ label: b, p: (1 - p) / rest.length }))];
}

function loadGemini() {
  return {
    kind: 'gemini',
    mode: 'ondemand',
    detail: `Gemini · ${el.cfgGeminiModel.value.trim()}`,
    async predict(video) {
      const key = el.cfgKey.value.trim();
      if (!key) throw new Error('No API key. Paste one in the settings bar below.');
      const model = el.cfgGeminiModel.value.trim() || 'gemini-2.5-flash';
      // ?key= avoids the CORS preflight that the x-goog-api-key header triggers.
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: VISION_PROMPT },
              { inline_data: { mime_type: 'image/jpeg', data: captureFrame(video) } },
            ],
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429) throw new Error('Rate limited (free tier is 5-15/min). Wait a moment.');
        if (res.status === 400 && /API key/i.test(body)) throw new Error('API key rejected.');
        if (res.status === 404) throw new Error(`Model "${model}" not found for this key.`);
        throw new Error(`Gemini ${res.status}: ${body.slice(0, 160)}`);
      }

      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini.');

      let out;
      try { out = JSON.parse(text); }
      catch { throw new Error(`Unparseable response: ${text.slice(0, 120)}`); }
      return shapePrediction(out);
    },
  };
}

/* Groq. OpenAI-compatible endpoint, so the image goes in the standard
 * multimodal content array. Verified against this account: api.groq.com
 * returns access-control-allow-origin:* so a browser can call it directly with
 * no proxy, and qwen/qwen3.8-27b handles both image input and JSON mode.
 * qwen3.6-27b does NOT — it fails JSON validation — so do not "upgrade" down. */
/* When serve.py has a key for this provider the request goes through the local
 * proxy at /api/classify and the key never enters the browser at all. Falling
 * back to a direct call keeps the app usable when it is opened from a plain
 * static server with a key pasted into the settings bar. */
async function providerFetch(provider, model, payload, directUrl, directHeaders) {
  if (state.serverKeys[provider]) {
    return fetch('/api/classify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, payload }),
    });
  }
  return fetch(directUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...directHeaders },
    body: JSON.stringify(payload),
  });
}

/* An HTTPS page cannot open a plain ws:// socket - Chrome blocks it as mixed
 * content, and the failure is quiet: the page looks completely normal and MQTT
 * simply never connects. So on a hosted build the broker default switches to
 * the TLS listener before the first connection attempt. */
function fixBrokerForHttps() {
  if (location.protocol !== 'https:') return;
  const url = el.cfgBroker.value.trim();
  if (!url.startsWith('ws://')) return;
  el.cfgBroker.value = 'wss://broker.hivemq.com:8884/mqtt';
  log('Served over HTTPS — switched the broker to wss:// (ws:// is blocked as mixed content)', 'ok');
}

async function loadServerStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    state.serverKeys = d.providers || {};
    state.canSaveSamples = d.samples !== false;
    const held = Object.keys(state.serverKeys).filter((k) => state.serverKeys[k]);
    if (held.length) log(`Server holds a key for: ${held.join(', ')} (${d.source})`, 'ok');
  } catch { /* plain static server, or serve.py not running - direct mode */ }
}

function loadGroq() {
  return {
    kind: 'groq',
    mode: 'ondemand',
    detail: `Groq · ${el.cfgGeminiModel.value.trim()}`,
    async predict(video) {
      const key = el.cfgKey.value.trim();
      if (!state.serverKeys.groq && !key) {
        throw new Error('No Groq key. Restart serve.py with your key file, or paste a key below.');
      }
      const model = el.cfgGeminiModel.value.trim() || 'qwen/qwen3.8-27b';

      const res = await providerFetch('groq', model, {
          model,
          temperature: 0,
          max_tokens: 200,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: `${VISION_PROMPT}\n\nReply with ONLY this JSON object and nothing else:\n{"class":"BIODEGRADABLE|RECYCLABLE|NON_RECYCLABLE|NO_MATCH","confidence":0.0,"item":"short name","reason":"one sentence"}` },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${captureFrame(video)}` } },
            ],
          }],
        },
        'https://api.groq.com/openai/v1/chat/completions',
        { Authorization: `Bearer ${key}` });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 429) throw new Error('Groq rate limit reached. Wait a moment.');
        if (res.status === 401) throw new Error('Groq API key rejected.');
        if (res.status === 404) throw new Error(`Model "${model}" not available on this key.`);
        throw new Error(`Groq ${res.status}: ${body.slice(0, 160)}`);
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Empty response from Groq.');

      let out;
      try { out = JSON.parse(text); }
      catch {
        // Some models wrap JSON in prose or a code fence despite json_object mode.
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error(`Unparseable response: ${text.slice(0, 120)}`);
        out = JSON.parse(m[0]);
      }
      return shapePrediction(out);
    },
  };
}

async function loadTeachableMachine() {
  const model = await tmImage.load('model/model.json', 'model/metadata.json');
  const labels = model.getClassLabels();
  return {
    kind: 'teachable',
    mode: 'continuous',
    detail: `Teachable Machine · ${labels.length} classes`,
    async predict(video) {
      const out = await model.predict(video);
      return out
        .map((p) => ({ label: normaliseLabel(p.className) || p.className, p: p.probability }))
        .sort((a, b) => b.p - a.p);
    },
  };
}

async function loadMobileNetFallback() {
  const model = await mobilenet.load({ version: 2, alpha: 1.0 });
  return {
    kind: 'mobilenet',
    mode: 'continuous',
    detail: 'MobileNet heuristic · NOT waste-trained',
    async predict(video) {
      const raw = await model.classify(video, 10);
      const acc = { BIODEGRADABLE: 0, RECYCLABLE: 0, NON_RECYCLABLE: 0 };
      for (const r of raw) {
        const name = r.className.toLowerCase();
        for (const bin of BINS) {
          if (IMAGENET_MAP[bin].some((kw) => name.includes(kw))) { acc[bin] += r.probability; break; }
        }
      }
      const total = BINS.reduce((s, b) => s + acc[b], 0);
      if (total === 0) return BINS.map((b) => ({ label: b, p: 0 }));
      return BINS.map((b) => ({ label: b, p: acc[b] / total })).sort((a, b) => b.p - a.p);
    },
  };
}

async function initModel() {
  const want = el.cfgProvider.value;
  clearInterval(state.inferTimer);
  state.inferTimer = null;
  state.classifier = null;
  state.latest = [];
  state.note = null;
  renderBars();
  renderVerdict();
  pill(el.modelPill, 'model: loading…', 'warn');

  try {
    if (want === 'groq' || want === 'gemini') {
      state.classifier = want === 'groq' ? loadGroq() : loadGemini();
      const hasKey = !!el.cfgKey.value.trim() || !!state.serverKeys[want];
      pill(el.modelPill, `model: ${state.classifier.detail}`, hasKey ? 'ok' : 'warn');
      log(hasKey ? `${state.classifier.detail} ready`
            + (state.serverKeys[want] ? ' (key held server-side)' : '')
                 : `${want === 'groq' ? 'Groq' : 'Gemini'} selected but no API key yet.`,
          hasKey ? 'ok' : 'err');
    } else if (want === 'teachable') {
      state.classifier = await loadTeachableMachine();
      pill(el.modelPill, `model: ${state.classifier.detail}`, 'ok');
      log(`Loaded ${state.classifier.detail}`, 'ok');
    } else {
      state.classifier = await loadMobileNetFallback();
      pill(el.modelPill, 'model: HEURISTIC (untrained)', 'warn');
      log('MobileNet loaded. Accuracy on real waste will be poor.', 'err');
    }
  } catch (e) {
    pill(el.modelPill, 'model: FAILED', 'bad');
    log(`Model load failed: ${e.message}. ${want === 'teachable'
      ? 'Put an exported Teachable Machine model in classifier/model/.'
      : 'MobileNet needs internet on first load.'}`, 'err');
    return;
  }

  if (state.stream) startInference();
  renderVerdict();
}

/* ── views ────────────────────────────────────────────────────────────── */

function showView(name) {
  state.view = name;
  // The scanner is a modal overlay, not a view section, so it is not in this
  // list. Querying a #view-scanner that no longer exists threw a TypeError and
  // stopped tab switching dead.
  for (const v of ['station', 'circuit']) {
    const node = $(`#view-${v}`);
    if (node) node.hidden = v !== name;
  }
  // Switching tabs with the scanner open would otherwise leave it floating
  // over the wrong view with the camera still live.
  if (el.scanModalOverlay && !el.scanModalOverlay.hidden) closeScanner();
  document.querySelectorAll('.tab').forEach((t) => {
    const on = (t.dataset.view === 'station' && name !== 'circuit')
            || (t.dataset.view === 'circuit' && name === 'circuit');
    t.classList.toggle('tab--on', on);
    t.setAttribute('aria-selected', String(on));
  });
  if (name !== 'scanner' && state.stream) stopCamera();
}

function openScanner(binClass) {
  state.targetBin = binClass;
  state.latest = [];
  state.note = null;
  state.scanError = null;
  state.showResult = false;
  // Say this before the first click rather than after it silently fails.
  const p = el.cfgProvider.value;
  if ((p === 'groq' || p === 'gemini') && !el.cfgKey.value.trim() && !state.serverKeys[p]) {
    state.scanError = `No ${p === 'groq' ? 'Groq' : 'Gemini'} API key. `
      + 'Paste one into the settings bar at the bottom of the page.';
  }
  const m = META[binClass];
  if (el.scanModalIcon) el.scanModalIcon.innerHTML = m.iconSvg || m.icon;
  if (el.scanModalCard) el.scanModalCard.dataset.tone = m.key;
  if (el.scanModalTitle) el.scanModalTitle.textContent = m.name;
  if (el.scanModalSub) el.scanModalSub.textContent = 'SCAN TO SORT';
  if (el.scanModalOverlay) el.scanModalOverlay.hidden = false;
  if (el.scanStatusBadge) el.scanStatusBadge.textContent = 'READY';
  renderBars();
  renderVerdict();
  startCamera();
}

function closeScanner() {
  state.showResult = false;
  clearTimeout(state.closeTimer);
  state.closeTimer = null;
  state.scanError = null;
  state.lidEvent = null;
  if (el.scanModalOverlay) el.scanModalOverlay.hidden = true;
  state.targetBin = null;
  stopCamera();
}

/* ── camera ───────────────────────────────────────────────────────────── */

async function listCameras() {
  try {
    const cams = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'videoinput');
    el.camSelect.innerHTML = '';
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Camera ${i + 1}`;
      el.camSelect.append(o);
    });
  } catch { /* enumeration needs permission first; harmless before start */ }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    scanFail('Camera unavailable. Serve over http://localhost, not file://');
    return;
  }

  /* The first open has no device selected, so it asks with a soft facingMode
   * preference and the browser picks a working camera. listCameras() then fills
   * the picker, and every later open inherited that id as an EXACT constraint -
   * which throws OverconstrainedError whenever the id has gone stale or the
   * first enumerated device is not the one that actually works (a virtual cam,
   * an IR sensor). That is why bin one worked and bin two did not.
   *
   * A specific device is now a preference, with a fallback to any camera. */
  const wanted = el.camSelect ? el.camSelect.value : '';
  const attempts = wanted
    ? [{ deviceId: { exact: wanted } }, { facingMode: 'environment' }, true]
    : [{ facingMode: 'environment' }, true];

  let lastErr = null;
  for (const video of attempts) {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // A refusal or a missing camera will not improve on the next attempt.
      if (e.name === 'NotAllowedError' || e.name === 'NotFoundError') break;
    }
  }

  if (lastErr || !state.stream) {
    const why = lastErr?.name === 'NotAllowedError'
      ? 'Camera permission denied. Allow it in the address bar, then press Enable Camera.'
      : lastErr?.name === 'NotFoundError'
        ? 'No camera found on this device.'
        : lastErr?.name === 'NotReadableError'
          ? 'The camera is in use by another app. Close it and press Enable Camera.'
          : `Camera failed: ${lastErr?.message || 'unknown error'}`;
    scanFail(why);
    return;
  }

  try {
    el.cam.srcObject = state.stream;
    await el.cam.play();
  } catch (e) {
    scanFail(`Camera stream would not play: ${e.message}`);
    return;
  }

  if (el.camOverlay) el.camOverlay.hidden = true;
  if (el.stopCam) el.stopCam.disabled = false;
  if (el.present) el.present.disabled = false;
  await listCameras();
  startInference();
  renderVerdict();
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  if (el.cam) el.cam.srcObject = null;
  if (el.camOverlay) el.camOverlay.hidden = false;
  if (el.stopCam) el.stopCam.disabled = true;
  if (el.present) el.present.disabled = true;
  clearInterval(state.inferTimer);
  state.inferTimer = null;
  state.latest = [];
  renderBars();
  renderVerdict();
}

/* ── inference ────────────────────────────────────────────────────────── */

function startInference() {
  clearInterval(state.inferTimer);
  state.inferTimer = null;
  // On-demand providers (Gemini) are metered and rate-limited, so they are
  // driven by the Present item button rather than a timer.
  if (state.classifier?.mode !== 'continuous') return;
  state.inferTimer = setInterval(async () => {
    if (!state.classifier || (!state.stream && !el.cam?.srcObject) || el.cam.readyState < 2) return;
    try {
      state.latest = await state.classifier.predict(el.cam);
      renderBars();
      renderVerdict();
      trackStability();
    } catch (e) {
      log(`Inference error: ${e.message}`, 'err');
    }
  }, INFER_MS);
}

async function classifyOnce(note) {
  if (state.busy) return;
  if (!state.classifier) { scanFail('No classifier loaded — pick one in the settings bar.'); return; }
  const hasCamera = !!(state.stream || (el.cam && (el.cam.srcObject || el.cam.readyState >= 1)));
  if (!hasCamera) { scanFail('Camera is not running. Press Enable Camera.'); return; }

  state.scanError = null;
  state.lidEvent = null;
  state.showResult = false;
  clearTimeout(state.closeTimer);
  state.closeTimer = null;
  state.busy = true;
  if (el.present) {
    el.present.disabled = true;
    el.present.textContent = 'Scanning…';
  }
  renderVerdict();

  try {
    /* Retry before rejecting.
     *
     * Most NO_MATCH results are lighting, angle or motion blur rather than a
     * genuinely unclassifiable item, and refusing a correct item is the
     * expensive failure: a bin that rejects too often gets bypassed and the
     * waste ends up beside it. So take up to MAX_SCAN_ATTEMPTS shots and keep
     * the most confident one, stopping the moment a usable answer arrives.
     *
     * Lowering CONFIDENCE_MIN would be the wrong fix - it buys fewer false
     * rejects by admitting contamination, which is the thing this system
     * exists to prevent.
     */
    let best = null;
    for (let attempt = 1; attempt <= MAX_SCAN_ATTEMPTS; attempt++) {
      if (el.present && attempt > 1) el.present.textContent = `Scanning… ${attempt}/${MAX_SCAN_ATTEMPTS}`;
      let shot;
      try {
        shot = await state.classifier.predict(el.cam);
      } catch (e) {
        // A rate limit or a rejected key will not improve on retry.
        if (best) break;
        throw e;
      }
      const top = shot[0];
      if (!best || top.p > best[0].p) best = shot;
      // good enough to act on: stop spending calls
      if (top.label !== 'NO_MATCH' && top.p >= threshold()) break;
      if (attempt < MAX_SCAN_ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_GAP_MS));
    }

    state.latest = best || [];
    renderBars();
    renderVerdict();
    publishClassification(note);
  } catch (e) {
    scanFail(e.message);
  } finally {
    // decide() reports SCANNING while busy is set, so the outcome can only be
    // read once it is cleared. Doing this inside the try meant the ACCEPT
    // branch never fired and the lid narration silently never started.
    state.busy = false;
    const isLive = !!(state.stream || (el.cam && (el.cam.srcObject || el.cam.readyState >= 1)));
    if (el.present) {
      el.present.textContent = 'Scan Item';
      el.present.disabled = !isLive;
    }

    if (!state.scanError) {
      const d = decide();
      if (d.verdict === 'ACCEPT' && state.targetBin) {
        countAccept(META[state.targetBin].key, false);
        startLidPhase(META[state.targetBin].key);
        scheduleClose(LID_OPEN_MS + PLACED_MS);
      } else if (d.kind === 'reject' || d.kind === 'nomatch') {
        scheduleClose(REJECT_CLOSE_MS);
      }
    }
    renderVerdict();
  }
}

/* Close the bin on its own once the outcome has been shown. A refusal gets
 * longer, because the manual override lives inside this modal and closing it
 * out from under someone who was reaching for it would be worse than waiting. */
function scheduleClose(ms) {
  // The camera and the button have done their job; the outcome takes the space.
  // The stream itself stays open, because a manual override still needs a frame
  // to file as a training sample.
  state.showResult = true;
  clearTimeout(state.closeTimer);
  state.closeTimer = setTimeout(() => { state.closeTimer = null; closeScanner(); }, ms);
}

/* Failures used to go only to log(), which renders inside the Circuit tab and
 * is invisible while the scan modal is open. Every silent "nothing happened"
 * click was an error nobody could read. Route them through here instead. */
function scanFail(msg) {
  state.scanError = msg;
  log(msg, 'err');
  renderVerdict();
}

function threshold() {
  const v = parseFloat(el.cfgConf.value);
  return Number.isFinite(v) ? v : 0.7;
}

/** The decision the ESP32 is expected to reach, mirrored for the operator. */
function decide() {
  if (!state.targetBin) return { verdict: 'IDLE', kind: 'idle', why: 'Pick a bin' };
  const hasCamera = !!(state.stream || (el.cam && (el.cam.srcObject || el.cam.readyState >= 1)));
  if (!hasCamera) return { verdict: 'OFF', kind: 'idle', why: 'Camera is off — click Enable Camera' };
  if (state.busy) return { verdict: 'SCANNING', kind: 'idle', why: 'Analyzing waste item with AI…' };
  if (!state.latest.length) {
    return { verdict: 'READY', kind: 'idle', why: 'Point camera at item and tap Scan Item' };
  }
  const top = state.latest[0];
  if (top.label === 'NO_MATCH') {
    return { verdict: 'NO MATCH', kind: 'nomatch', reason: 'no_item',
             why: 'No identifiable waste item presented — lid stays locked' };
  }
  if (top.p < threshold()) {
    return { verdict: 'NO MATCH', kind: 'nomatch', reason: 'low_confidence',
             why: `Best guess ${top.label} at ${(top.p * 100).toFixed(0)}%, below ${(threshold() * 100).toFixed(0)}% threshold — lid stays locked` };
  }
  if (top.label !== state.targetBin) {
    return { verdict: 'REJECT', kind: 'reject', reason: 'class_mismatch',
             why: `Detected ${top.label} at the ${SHORT[state.targetBin]} bin — lid stays locked` };
  }
  return { verdict: 'ACCEPT', kind: 'accept', reason: null,
           why: `${top.label} at ${(top.p * 100).toFixed(0)}% matches this bin — lid unlocks!` };
}

/* What the operator should physically DO about this verdict. "REJECTED" is not
 * actionable; "too dark, move closer" is. On a genuine mismatch the most useful
 * thing is to name the bin the item actually belongs in. */
function advice(d) {
  if (!d || !d.reason) return null;
  const top = state.latest[0];
  if (d.reason === 'no_item') {
    return 'The lid will not open — no item recognised. '
         + 'Hold one item in the middle of the frame and scan again.';
  }
  if (d.reason === 'low_confidence') {
    return 'The lid will not open — item not recognised clearly. '
         + 'Move it closer, hold it still, and give it more light.';
  }
  if (d.reason === 'class_mismatch' && top && META[top.label]) {
    return `The lid will not open — that looks like ${META[top.label].name.toLowerCase()}. `
         + `Try the ${META[top.label].short} bin, or override below if this is wrong.`;
  }
  if (d.reason === 'bin_full') return 'The lid will not open — this bin is full.';
  return null;
}

function trackStability() {
  const top = state.latest[0];
  if (!top) return;
  if (top.label !== state.stableLabel) {
    state.stableLabel = top.label;
    state.stableSince = Date.now();
    return;
  }
  if (!el.autoPresent?.checked) return;
  const now = Date.now();
  if (now - state.stableSince >= STABLE_MS && now - state.lastAutoPublish >= COOLDOWN_MS) {
    if (decide().verdict !== 'IDLE' && decide().verdict !== 'READY') {
      state.lastAutoPublish = now;
      publishClassification('auto');
    }
  }
}

/* ── rendering ────────────────────────────────────────────────────────── */

function renderBars() {
  if (!el.bars) return;
  if (!state.latest.length) {
    el.bars.innerHTML = '<p class="empty">No prediction yet.</p>';
    return;
  }
  el.bars.innerHTML = '';
  state.latest.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (i === 0 ? ' row--top' : '');
    const k = document.createElement('span');
    k.className = 'row__k';
    k.textContent = SHORT[p.label] ? `${SHORT[p.label]} · ${p.label.toLowerCase()}` : p.label;
    const track = document.createElement('div');
    track.className = 'track';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = `${(p.p * 100).toFixed(1)}%`;
    track.append(fill);
    const v = document.createElement('span');
    v.className = 'row__v';
    v.textContent = `${(p.p * 100).toFixed(0)}%`;
    row.append(k, track, v);
    el.bars.append(row);
  });
}

/* While the controller is actually opening a lid, the modal narrates that
 * instead of repeating the classification verdict. Expires on its own, so a
 * stale phase cannot linger if no further events arrive. */
/* Start the open -> placed narration.
 *
 * Fires on our own ACCEPT so the sequence plays during a UI-only demonstration,
 * and again on the controller's ACCEPT event when Wokwi is running, which
 * re-syncs the timing to the lid that actually moved. */
/* Counting an accepted item.
 *
 * These used to increment only on the controller's ACCEPT event, so with no
 * ESP32 running they sat at zero forever. They now count the page's own accepts
 * too, and persist, so a demonstration keeps its tally across a reload.
 *
 * Both paths can fire for one item when Wokwi is running, so a bin will not
 * count twice inside COUNT_DEDUPE_MS.
 */
const COUNT_DEDUPE_MS = 6000;

/* Must match firmware/smart_bin.ino. The controller models each admitted item
 * as occupying this much of the bin, and calls it full at that threshold; the
 * page mirrors the same arithmetic when no controller is reporting, so the two
 * agree instead of telling different stories. */
const DEPOSIT_PCT_PER_ITEM = 8;
const FULL_THRESHOLD_PCT = 85;

function countAccept(binKey, viaOverride) {
  const s = state.bins[binKey];
  if (!s) return;
  const now = Date.now();
  if (now - (s.lastCountedAt || 0) < COUNT_DEDUPE_MS) return;
  s.lastCountedAt = now;
  s.collected += 1;
  if (viaOverride) s.overridden += 1;
  saveCounts();
  renderAll();
}

function saveCounts() {
  try {
    localStorage.setItem('swm.counts', JSON.stringify(
      Object.fromEntries(BINS.map((b) => {
        const s = state.bins[META[b].key];
        return [META[b].key, { c: s.collected, o: s.overridden }];
      }))));
  } catch { /* private mode - the tally just will not survive a reload */ }
}

function loadCounts() {
  try {
    const raw = JSON.parse(localStorage.getItem('swm.counts') || '{}');
    for (const b of BINS) {
      const s = state.bins[META[b].key];
      const v = raw[META[b].key];
      if (!v) continue;
      s.collected = Number(v.c) || 0;
      s.overridden = Number(v.o) || 0;
    }
  } catch { /* corrupt or blocked storage - start from zero */ }
}

function startLidPhase(binKey) {
  const now = Date.now();
  state.lidEvent = { key: binKey, opensUntil: now + LID_OPEN_MS };
  renderVerdict();
}

function lidPhase() {
  const e = state.lidEvent;
  if (!e) return null;
  if (Date.now() < e.opensUntil) {
    return { label: 'OPENING', kind: 'accept', text: 'Bin is opening — place the item inside.' };
  }
  // PLACED is the settled outcome and stays put. It used to expire after a few
  // seconds and fall back to a bare ACCEPT, which looks exactly like nothing
  // having happened - you had to be watching the screen to catch it at all.
  // It is cleared by the next scan or by closing the bin.
  return { label: 'PLACED', kind: 'accept', text: 'Item placed in the bin.' };
}

function renderVerdict() {
  const d = decide();
  const phase = lidPhase();
  if (el.verdict) {
    el.verdict.className = `verdict verdict--${d.kind || 'idle'}`;
    const lbl = el.verdict.querySelector('.verdict__label');
    const why = el.verdict.querySelector('.verdict__why');
    if (lbl) lbl.textContent = d.verdict;
    if (why) why.textContent = d.why;
    if (el.verdictItem) {
      el.verdictItem.textContent = state.note || '';
      el.verdictItem.hidden = !state.note;
    }
  }
  if (el.scanModalCard) {
    el.scanModalCard.dataset.state = state.showResult ? 'result' : 'scanning';
  }
  if (el.scanResult) el.scanResult.hidden = !state.showResult;
  if (el.scanResultLabel) {
    el.scanResultLabel.textContent = state.scanError ? 'ERROR' : (phase ? phase.label : d.verdict);
    el.scanResultLabel.dataset.kind = state.scanError ? 'reject' : (phase ? phase.kind : (d.kind || 'idle'));
  }
  if (el.scanStatusBadge) {
    el.scanStatusBadge.textContent =
      state.scanError ? 'ERROR' : (phase ? phase.label : d.verdict);
    el.scanStatusBadge.dataset.kind =
      state.scanError ? 'reject' : (phase ? phase.kind : (d.kind || 'idle'));
  }
  // The verdict block is display:none in this layout, so without this the
  // operator sees a bare ACCEPT/REJECT badge and never learns why. The model's
  // one-line reason is the most demonstrable part of the whole system.
  if (el.scanModalHint) {
    const tip = advice(d);
    if (phase) {
      el.scanModalHint.textContent = phase.text;
      el.scanModalHint.dataset.kind = phase.kind;
      return;
    }
    el.scanModalHint.textContent = state.scanError
      || (tip ? `${state.note ? state.note + ' — ' : ''}${tip}`
              : (state.note || d.why || 'Point camera at item to identify'));
    el.scanModalHint.dataset.kind = state.scanError ? 'error' : (d.kind || 'idle');
  }
}

function binView(binClass) {
  const m = META[binClass];
  const s = state.bins[m.key];
  const now = Date.now();

  const seen = s.lastSeen > 0;
  const stale = seen && now - s.lastSeen > STALE_MS;
  const live = seen && !stale;

  /* Telemetry is authoritative whenever it is arriving. With no controller the
   * page falls back to the same model the firmware uses - each accepted item
   * occupies DEPOSIT_PCT_PER_ITEM - so the capacity bar responds to sorting
   * during a UI-only demonstration instead of sitting at a dash forever. */
  const modelled = Math.min(100, s.collected * DEPOSIT_PCT_PER_ITEM);
  const fill = live ? (s.fill ?? 0) : modelled;
  const known = live || s.collected > 0;
  const full = known && (live ? s.status === 'FULL' : fill >= FULL_THRESHOLD_PCT);
  const lidOpen = now < s.lidOpenUntil;

  return { m, s, seen, stale, live, known, fill, full, lidOpen };
}

/* The cards are built once and then patched in place.
 *
 * They used to be rebuilt wholesale on every repaint, and renderAll runs on a
 * 500ms timer, so the card under the cursor was destroyed and recreated twice
 * a second. That restarted the hover transition from zero each time, which read
 * as a stutter. Replacing a node also drops focus and cancels :active.
 */
function buildBinCards() {
  el.binCards.innerHTML = '';
  for (const binClass of BINS) {
    const m = META[binClass];
    const card = document.createElement('div');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.className = 'binCard';
    card.dataset.bin = binClass;
    card.dataset.tone = m.key;
    card.innerHTML = `
      <div class="binCard__icon">${m.iconSvg || m.icon}</div>
      <h3 class="binCard__name">${m.name}</h3>
      <p class="binCard__count" data-f="count"></p>
      <div class="cap">
        <div class="cap__head">
          <span class="cap__k">Capacity</span>
          <span class="cap__v" data-f="cap"></span>
        </div>
        <div class="cap__track"><div class="cap__fill" data-f="fill"></div></div>
      </div>
      <button class="binCard__circuit" data-goto="circuit" type="button">View circuit</button>`;
    el.binCards.append(card);
  }
}

function renderBinCards() {
  if (!el.binCards) return;
  if (el.binCards.children.length !== BINS.length) buildBinCards();

  BINS.forEach((binClass, i) => {
    const card = el.binCards.children[i];
    if (!card) return;
    const { s, stale, known, fill, full } = binView(binClass);

    card.classList.toggle('binCard--stale', stale);
    card.classList.toggle('binCard--full', full);

    // Only touch the DOM when the value actually changed, so an unchanged card
    // is left completely alone between ticks.
    const put = (field, value) => {
      const n = card.querySelector(`[data-f="${field}"]`);
      if (n && n.textContent !== value) n.textContent = value;
    };
    put('count', s.overridden
      ? `${s.collected} items collected · ${s.overridden} overridden`
      : `${s.collected} items collected`);
    put('cap', known ? `${fill}%` : '—');

    const bar = card.querySelector('[data-f="fill"]');
    const width = `${known ? fill : 0}%`;
    if (bar && bar.style.width !== width) bar.style.width = width;
  });

  updateHeader();
}

function updateHeader() {
  const total = BINS.reduce((n, b) => n + state.bins[META[b].key].collected, 0);
  el.totalSorted.textContent = total;

  const connected = !!state.client?.connected;
  const fresh = BINS.filter((b) => Date.now() - state.bins[META[b].key].lastSeen < STALE_MS).length;
  let kind = 'bad', why = 'broker offline';
  if (connected && fresh === 3) { kind = 'ok'; why = 'broker connected, 3/3 bins reporting'; }
  else if (connected && fresh) { kind = 'warn'; why = `broker connected, ${fresh}/3 bins reporting`; }
  else if (connected) { kind = 'warn'; why = 'broker connected, no telemetry from the controller'; }
  el.statusDot.className = `statusDot statusDot--${kind}`;
  el.statusDot.title = why;
}

function renderCircuitCards() {
  if (!el.circuitCards) return;   // per-bin telemetry cards were removed
  el.circuitCards.innerHTML = '';
  for (const binClass of BINS) {
    const { m, s, stale, live, known, fill, full, lidOpen } = binView(binClass);
    const p = PINS[m.key];
    const card = document.createElement('div');
    card.className = 'binCard binCard--static'
      + (stale ? ' binCard--stale' : '') + (full ? ' binCard--full' : '');
    card.dataset.tone = m.key;
    card.innerHTML = `
      <span class="binCard__icon">${m.icon}</span>
      <h3 class="binCard__name">${m.name}</h3>
      <p class="binPins">
        TRIG ${pinLabel(p.trig)} · ECHO ${pinLabel(p.echo)}<br>
        SERVO ${pinLabel(p.servo)} · LED ${pinLabel(p.red)}/${pinLabel(p.green)}
      </p>
      <div class="binStats">
        <div class="stat"><span class="stat__k">Fill</span>
          <span class="stat__v ${full ? 'stat__v--bad' : ''}">${known ? fill + '%' : '—'}</span></div>
        <div class="stat"><span class="stat__k">Gas</span>
          <span class="stat__v">${live && s.gas != null ? s.gas : '—'}</span></div>
        <div class="stat"><span class="stat__k">Lid</span>
          <span class="stat__v ${lidOpen ? 'stat__v--ok' : ''}">${lidOpen ? 'open' : 'locked'}</span></div>
      </div>
      <p class="binEvent ${s.event === 'ACCEPT' ? 'binEvent--accept' : s.event === 'REJECT' ? 'binEvent--reject' : ''}">
        ${s.event ? `${s.event}${s.reason ? ' · ' + s.reason : ''}` : '—'}
      </p>`;
    el.circuitCards.append(card);
  }

  const seen = BINS.filter((b) => state.bins[META[b].key].lastSeen > 0).length;
  const fresh = BINS.filter((b) => Date.now() - state.bins[META[b].key].lastSeen < STALE_MS).length;
  if (!seen) pill(el.stationPill, 'no telemetry yet', 'warn');
  else if (!fresh) pill(el.stationPill, 'controller silent', 'bad');
  else pill(el.stationPill, `${fresh}/3 bins reporting`, 'ok');
}

function renderAll() {
  if (el.scanModalOverlay && !el.scanModalOverlay.hidden) renderVerdict();
  if (state.view === 'station') renderBinCards();
  else updateHeader();
  if (state.view === 'circuit') renderCircuitCards();
}

/* ── MQTT ─────────────────────────────────────────────────────────────── */

function subscribeTelemetry() {
  const root = el.cfgTopic.value.trim();
  for (const leaf of ['telemetry', 'event']) {
    const t = `${root}/bin/+/${leaf}`;
    state.client.subscribe(t, (err) => {
      if (err) log(`Subscribe failed: ${t}`, 'err');
      else log(`Subscribed ${t}`, 'ok');
    });
  }
}

function onBrokerMessage(topic, buf) {
  const root = el.cfgTopic.value.trim();
  const m = topic.startsWith(`${root}/bin/`)
    ? topic.slice(root.length + 5).split('/') : null;
  if (!m || m.length !== 2) return;
  const [key, leaf] = m;
  const s = state.bins[key];
  if (!s) return;

  let doc;
  try { doc = JSON.parse(buf.toString()); }
  catch { log(`Bad JSON on ${topic}`, 'err'); return; }

  s.lastSeen = Date.now();
  if (leaf === 'telemetry') {
    s.fill = doc.fill ?? s.fill;
    s.gas = doc.gas ?? s.gas;
    s.status = doc.status ?? s.status;
  } else {
    s.event = doc.event ?? null;
    s.reason = doc.reason ?? null;
    s.eventAt = Date.now();
    if (doc.fill != null) s.fill = doc.fill;
    if (doc.event === 'ACCEPT') {
      const now = Date.now();
      s.lidOpenUntil = now + LID_OPEN_MS;
      countAccept(key, doc.reason === 'manual_override');
      // Narrate the lid cycle the controller is actually performing, but only
      // for the bin currently on screen. Driven by the event rather than by our
      // own verdict, so the page never claims a lid opened when none did.
      if (state.targetBin && META[state.targetBin].key === key) startLidPhase(key);
    }
    if (doc.event === 'FULL') s.status = 'FULL';
    log(`${BY_KEY[key]} ${doc.event}${doc.reason ? ' (' + doc.reason + ')' : ''}`,
        doc.event === 'ACCEPT' ? 'ok' : doc.event ? 'err' : undefined);
  }
  renderAll();
}

function connect() {
  if (state.client) { try { state.client.end(true); } catch {} state.client = null; }
  const url = el.cfgBroker.value.trim();
  pill(el.mqttPill, 'broker: connecting…', 'warn');
  log(`Connecting to ${url}`);
  try {
    state.client = mqtt.connect(url, {
      clientId: `swm-classifier-${Math.random().toString(16).slice(2, 10)}`,
      connectTimeout: 8000, reconnectPeriod: 4000, clean: true,
    });
  } catch (e) {
    pill(el.mqttPill, 'broker: bad URL', 'bad');
    log(`Connect failed: ${e.message}`, 'err');
    return;
  }
  state.client.on('connect', () => {
    pill(el.mqttPill, 'broker: connected', 'ok');
    log('Broker connected', 'ok');
    subscribeTelemetry();
  });
  state.client.on('message', onBrokerMessage);
  state.client.on('reconnect', () => pill(el.mqttPill, 'broker: reconnecting…', 'warn'));
  state.client.on('close', () => pill(el.mqttPill, 'broker: offline', 'bad'));
  state.client.on('error', (e) => {
    pill(el.mqttPill, 'broker: error', 'bad');
    log(`Broker error: ${e.message}`, 'err');
  });
}

function publish(payload, note) {
  const topic = `${el.cfgTopic.value.trim()}/classify`;
  const body = JSON.stringify(payload);
  if (!state.client?.connected) { log(`OFFLINE, not sent: ${body}`, 'err'); return; }
  state.client.publish(topic, body, { qos: 0 }, (err) => {
    if (err) log(`Publish failed: ${err.message}`, 'err');
    else log(`${topic} ${body}${note ? ` (${note})` : ''}`, 'ok');
  });
}

function publishClassification(note) {
  const top = state.latest[0];
  if (!top || !state.targetBin) {
    log('Nothing to publish — need a prediction and a target bin', 'err');
    return;
  }
  const below = top.p < threshold();
  const payload = {
    class: (below || top.label === 'NO_MATCH') ? 'NO_MATCH' : top.label,
    confidence: Number(top.p.toFixed(4)),
    target: SHORT[state.targetBin],
    source: state.classifier?.kind ?? 'unknown',
    ts: Math.floor(Date.now() / 1000),
  };
  if (state.note) payload.item = state.note;
  publish(payload, note);
}

/* An override is a human correcting the model, so the frame plus the corrected
 * label is exactly the sample a later on-device model would be fine-tuned on.
 * This captures that pair. It SIMULATES the collection stage of the TFLite
 * Micro / Edge Impulse path the project document specifies - nothing here
 * trains anything, and the paper should say so.
 *
 * The camera frame is discarded after classification, so it has to be grabbed
 * again here or the label would have no image attached to it. */
async function captureCorrection(label) {
  // Vercel's filesystem is read-only apart from an ephemeral /tmp, so a hosted
  // build would accept samples and silently discard them. Better to not offer.
  if (state.canSaveSamples === false) {
    log('Correction not saved — the hosted build has no writable storage', 'err');
    return;
  }
  const live = !!(state.stream && el.cam && el.cam.readyState >= 2);
  if (!live) { log('No frame to capture — camera is not running', 'err'); return; }
  const top = state.latest[0];
  try {
    const res = await fetch('/api/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        image: captureFrame(el.cam),
        modelSaid: top ? top.label : '',
        confidence: top ? Number(top.p.toFixed(3)) : '',
        target: SHORT[state.targetBin] || '',
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      log(`Correction not saved: ${d.error || res.status}`, 'err');
      return;
    }
    const d = await res.json();
    state.samples = d.counts || state.samples;
    state.sampleTotal = d.total ?? state.sampleTotal;
    log(`Correction saved as ${d.saved} — ${d.total} training samples`, 'ok');
    if (el.scanModalHint) {
      el.scanModalHint.dataset.kind = 'accept';
      el.scanModalHint.textContent =
        `Saved as a ${META[label].name.toLowerCase()} training sample — ${d.total} collected`;
    }
  } catch (e) {
    log(`Correction not saved: ${e.message}`, 'err');
  }
}

async function loadSampleCounts() {
  if (state.canSaveSamples === false) return;
  try {
    const r = await fetch('/api/samples', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    state.samples = d.counts || {};
    state.sampleTotal = d.total || 0;
    if (d.total) log(`${d.total} training samples already collected in ${d.dir}`, 'ok');
  } catch { /* served by something other than serve.py */ }
}

function publishManual(label) {
  if (!state.targetBin) { log('Open a bin first', 'err'); return; }
  // source:'manual' tells the firmware a human forced this, so it is admitted
  // and published as an override rather than laundered as a model decision.
  publish({
    class: label, confidence: 1, target: SHORT[state.targetBin],
    source: 'manual', override: true, ts: Math.floor(Date.now() / 1000),
  }, 'manual override');
  if (state.targetBin) {
    countAccept(META[state.targetBin].key, true);
    startLidPhase(META[state.targetBin].key);
  }
  captureCorrection(label);
}

/* ── wiring ───────────────────────────────────────────────────────────── */

el.binCards.addEventListener('click', (e) => {
  // the circuit shortcut sits inside the card, so it must claim the click first
  if (e.target.closest('[data-goto="circuit"]')) { showView('circuit'); return; }
  const card = e.target.closest('.binCard');
  if (!card?.dataset.bin) return;
  // A full bin refuses everything, so opening its camera would only mislead.
  if (card.classList.contains('binCard--full')) {
    log(`${card.dataset.bin} is full — empty it before scanning`, 'err');
    return;
  }
  openScanner(card.dataset.bin);
});

/* The frame and this page are independent clients of the MQTT broker; the
 * iframe is a convenience, not a data path. If Wokwi refuses to be framed the
 * fallback text and the new-tab link still give a working route. */
function applyWokwiProject() {
  const id = (el.cfgWokwiId.value || '').trim().replace(/\D/g, '');
  if (!id) return;
  const url = `https://wokwi.com/projects/${id}`;
  if (el.wokwiFrame.src !== url) el.wokwiFrame.src = url;
  el.wokwiOpen.href = url;
  try { localStorage.setItem('swm.wokwiId', id); } catch {}
}
if (el.cfgWokwiId) {
  try {
    const saved = localStorage.getItem('swm.wokwiId');
    if (saved) el.cfgWokwiId.value = saved;
  } catch {}
  el.cfgWokwiId.addEventListener('change', applyWokwiProject);
  applyWokwiProject();
}

// the card is a div now, so Enter and Space have to be wired by hand
el.binCards.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const hit = e.target.closest('[data-goto="circuit"], .binCard');
  if (!hit) return;
  e.preventDefault();
  hit.click();
});

el.helpBtn.addEventListener('click', () => { el.helpPanel.hidden = !el.helpPanel.hidden; });
el.helpClose.addEventListener('click', () => { el.helpPanel.hidden = true; });
if (el.closeScanModal) el.closeScanModal.addEventListener('click', closeScanner);
if (el.scanModalOverlay) {
  el.scanModalOverlay.addEventListener('click', (e) => {
    if (e.target === el.scanModalOverlay) closeScanner();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!el.helpPanel.hidden) el.helpPanel.hidden = true;
    else if (el.scanModalOverlay && !el.scanModalOverlay.hidden) closeScanner();
  }
});

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showView(t.dataset.view)));

el.startCam.addEventListener('click', startCamera);
if (el.stopCam) el.stopCam.addEventListener('click', stopCamera);
if (el.camSelect) el.camSelect.addEventListener('change', () => { if (state.stream) { stopCamera(); startCamera(); } });
if (el.clearLog) el.clearLog.addEventListener('click', () => { el.log.innerHTML = ''; });
el.reconnect.addEventListener('click', connect);
document.querySelectorAll('[data-manual]').forEach((b) =>
  b.addEventListener('click', () => publishManual(b.dataset.manual)));

el.present.addEventListener('click', () => {
  if (state.classifier?.mode === 'continuous') publishClassification('present');
  else classifyOnce('present');
});

const SAVED = ['cfgProvider', 'cfgConf', 'cfgBroker', 'cfgTopic'];

/* Cloud providers each get their own stored key and model, so switching
 * between Groq and Gemini does not send one provider's key to the other. */
const CLOUD = {
  groq:   { name: 'Groq',   model: 'qwen/qwen3.8-27b' },
  gemini: { name: 'Gemini', model: 'gemini-2.5-flash' },
};
const isCloud = () => !!CLOUD[el.cfgProvider.value];

function applyProviderVisibility() {
  const cloud = isCloud();
  document.querySelectorAll('.cloudOnly').forEach((n) => { n.hidden = !cloud; });
  if (el.autoPresent) {
    el.autoPresent.disabled = cloud;
    if (el.autoPresent.parentElement) {
      el.autoPresent.parentElement.title = cloud
        ? 'Disabled for cloud providers — every scan is a metered API call' : '';
    }
    if (cloud) el.autoPresent.checked = false;
  }
}

/** Swap the key and model fields to whichever cloud provider is selected. */
function loadProviderCreds() {
  const p = el.cfgProvider.value;
  if (!CLOUD[p]) return;
  try {
    el.cfgKey.value = localStorage.getItem(`swm.key.${p}`) || '';
    el.cfgGeminiModel.value = localStorage.getItem(`swm.model.${p}`) || CLOUD[p].model;
  } catch {
    el.cfgGeminiModel.value = CLOUD[p].model;
  }
}

function saveProviderCreds() {
  const p = el.cfgProvider.value;
  if (!CLOUD[p]) return;
  try {
    localStorage.setItem(`swm.key.${p}`, el.cfgKey.value);
    localStorage.setItem(`swm.model.${p}`, el.cfgGeminiModel.value);
  } catch { /* private mode — the session still works, it just will not persist */ }
}

function restoreSettings() {
  for (const id of SAVED) {
    try {
      const v = localStorage.getItem(`swm.${id}`);
      if (v !== null) el[id].value = v;
    } catch { /* private mode or blocked storage — defaults are fine */ }
  }
  loadProviderCreds();
}

for (const id of SAVED) {
  el[id].addEventListener('change', () => {
    try { localStorage.setItem(`swm.${id}`, el[id].value); } catch {}
  });
}

el.cfgProvider.addEventListener('change', () => {
  loadProviderCreds();
  applyProviderVisibility();
  initModel();
});
el.cfgGeminiModel.addEventListener('change', () => { saveProviderCreds(); if (isCloud()) initModel(); });
el.cfgKey.addEventListener('change', () => { saveProviderCreds(); if (isCloud()) initModel(); });
el.cfgTopic.addEventListener('change', () => { if (state.client?.connected) subscribeTelemetry(); });

// Repaint on a timer so staleness and the lid dwell expire on their own.
setInterval(renderAll, 500);

(async function main() {
  restoreSettings();
  loadCounts();
  applyProviderVisibility();
  renderBars();
  renderVerdict();
  renderAll();
  if (location.protocol === 'file:') {
    log('Opened via file:// — the camera will be blocked. Run serve.bat and use http://localhost:8000', 'err');
  }
  await listCameras();
  fixBrokerForHttps();
  await loadServerStatus();
  await loadSampleCounts();
  connect();
  await initModel();
})();
