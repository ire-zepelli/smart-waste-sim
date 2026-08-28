/* Zura — smart waste bins, station 01 front end.
 *
 * Surfaces:
 *   station   the three bins with live fill and lock state. Tap one to scan.
 *   scan      a modal holding that bin's camera. Classifies, publishes on MQTT.
 *   circuit   a live wiring schematic plus per-bin telemetry and raw traffic.
 *
 * Bin state is never simulated here. It arrives as telemetry from the ESP32 and
 * goes stale after STALE_MS rather than showing an old number as though it were
 * live. The schematic is driven by the same state, so an unpowered controller
 * shows dark LEDs and empty bins instead of a plausible-looking fiction.
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
      <g stroke="#000000" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M26 12L32 4L38 12"/>
        <path d="M32 4V24C32 24 32 30 40 30H54"/>
        <path d="M46 40L54 48L46 56"/>
        <path d="M54 48H36C36 48 30 48 26 40L18 26"/>
        <path d="M18 36L10 28L18 20"/>
        <path d="M10 28H24C24 28 30 28 34 20L42 6"/>
      </g>
      <g stroke="#60a5fa" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M26 12L32 4L38 12"/>
        <path d="M32 4V24C32 24 32 30 40 30H54"/>
        <path d="M46 40L54 48L46 56"/>
        <path d="M54 48H36C36 48 30 48 26 40L18 26"/>
        <path d="M18 36L10 28L18 20"/>
        <path d="M10 28H24C24 28 30 28 34 20L42 6"/>
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
  schematic: $('#schematic'),
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
  serverKeys: {},    // providers serve.py holds a key for, from /api/status
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
    collected: 0,   // ACCEPT events seen this session
  }])),
};

/* ── logging ──────────────────────────────────────────────────────────── */

function log(msg, kind) {
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

confidence is your own certainty from 0 to 1. item is a two-or-three word name for what you see. reason is one short sentence a student could read aloud during a demonstration.`;

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

async function loadServerStatus() {
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    state.serverKeys = d.providers || {};
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
  state.scanError = null;
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
    log('getUserMedia unavailable. Serve over http://localhost, not file://', 'err');
    return;
  }
  try {
    const deviceId = el.camSelect ? el.camSelect.value : '';
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
    });
    el.cam.srcObject = state.stream;
    await el.cam.play();
    if (el.camOverlay) el.camOverlay.hidden = true;
    if (el.stopCam) el.stopCam.disabled = false;
    if (el.present) el.present.disabled = false;
    await listCameras();
    startInference();
    renderVerdict();
  } catch (e) {
    log(`Camera failed: ${e.message}`, 'err');
    renderVerdict();
  }
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
  state.busy = true;
  if (el.present) {
    el.present.disabled = true;
    el.present.textContent = 'Scanning…';
  }
  renderVerdict();

  try {
    state.latest = await state.classifier.predict(el.cam);
    renderBars();
    renderVerdict();
    publishClassification(note);
  } catch (e) {
    scanFail(e.message);
  } finally {
    state.busy = false;
    const isLive = !!(state.stream || (el.cam && (el.cam.srcObject || el.cam.readyState >= 1)));
    if (el.present) {
      el.present.textContent = 'Scan Item';
      el.present.disabled = !isLive;
    }
    renderVerdict();
  }
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

function renderVerdict() {
  const d = decide();
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
  if (el.scanStatusBadge) {
    el.scanStatusBadge.textContent = state.scanError ? 'ERROR' : d.verdict;
    el.scanStatusBadge.dataset.kind = state.scanError ? 'reject' : (d.kind || 'idle');
  }
  // The verdict block is display:none in this layout, so without this the
  // operator sees a bare ACCEPT/REJECT badge and never learns why. The model's
  // one-line reason is the most demonstrable part of the whole system.
  if (el.scanModalHint) {
    el.scanModalHint.textContent =
      state.scanError || state.note || d.why || 'Point camera at item to identify';
    el.scanModalHint.classList.toggle('scanModalHint--err', !!state.scanError);
  }
}

function binView(binClass) {
  const m = META[binClass];
  const s = state.bins[m.key];
  const now = Date.now();
  const seen = s.lastSeen > 0;
  const stale = seen && now - s.lastSeen > STALE_MS;
  const live = seen && !stale;
  const full = live && s.status === 'FULL';
  const lidOpen = now < s.lidOpenUntil;
  return { m, s, seen, stale, live, full, lidOpen };
}

function capBlock(s, live, full) {
  const pct = live && s.fill != null ? s.fill : 0;
  return `
    <div class="cap">
      <div class="cap__head">
        <span class="cap__k">CAPACITY</span>
        <span class="cap__v">${pct}%</span>
      </div>
      <div class="cap__track"><div class="cap__fill" style="width:${pct}%"></div></div>
    </div>`;
}

function renderBinCards() {
  el.binCards.innerHTML = '';
  for (const binClass of BINS) {
    const { m, s, seen, stale, live, full } = binView(binClass);

    const card = document.createElement('button');
    card.className = 'binCard'
      + (stale || !seen ? ' binCard--stale' : '')
      + (full ? ' binCard--full' : '');
    card.dataset.bin = binClass;
    card.dataset.tone = m.key;
    card.type = 'button';

    card.innerHTML = `
      <div class="binCard__icon">${m.iconSvg || m.icon}</div>
      <h3 class="binCard__name">${m.name}</h3>
      <p class="binCard__count">${s.collected} items collected</p>
      ${capBlock(s, live, full)}`;
    el.binCards.append(card);
  }
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

/* ── schematic ────────────────────────────────────────────────────────────
 * A live wiring diagram of the station. Geometry is derived from one layout
 * table and the PINS map above, so the drawing cannot drift from the firmware:
 * change a pin in one place and the label, the pad and the wire all move.    */

const SCH = {
  w: 1240, h: 800,
  board: { x: 505, y: 120, w: 200, h: 545 },
  rows: [170, 345, 520],        // one per bin: bio, rec, non
  usX: 70, servoX: 800, ledX: 1055,
  potX: 120, potY: 690, btnY: 700,
};

const WIRE = { sig: '#4ade80', pwm: '#fb923c', pwr: '#f87171', gnd: '#64748b', adc: '#c084fc' };

/** Wokwi-ish ribbon wire: a horizontal-tangent cubic between two pads. */
function wire(x1, y1, x2, y2, colour, dim) {
  const k = Math.max(40, Math.abs(x2 - x1) * 0.42);
  return `<path d="M${x1} ${y1} C${x1 + (x2 > x1 ? k : -k)} ${y1}, ${x2 - (x2 > x1 ? k : -k)} ${y2}, ${x2} ${y2}"
           fill="none" stroke="${colour}" stroke-width="2.2" stroke-linecap="round"
           opacity="${dim ? .25 : .8}"/>`;
}

function pad(x, y, label, side) {
  const tx = side === 'left' ? x - 9 : x + 9;
  return `<circle cx="${x}" cy="${y}" r="4" class="pad"/>
    <text x="${tx}" y="${y + 3.5}" class="padTxt" text-anchor="${side === 'left' ? 'end' : 'start'}">${label}</text>`;
}

function renderSchematic() {
  if (!el.schematic) return;
  const B = SCH.board;
  const leftX = B.x, rightX = B.x + B.w;
  const wires = [], parts = [], pads = [];

  // Board-edge pad positions, spread evenly down each side.
  const L = {}, R = {};
  const leftOrder  = ['bioTrig','bioEcho','recTrig','recEcho','nonTrig','nonEcho','gas','btnBin','btnItem','gndL'];
  const rightOrder = ['bioServo','bioRed','bioGreen','recServo','recRed','recGreen','nonServo','nonRed','nonGreen','vin','gndR'];
  leftOrder.forEach((k, i) => { L[k] = B.y + 34 + i * ((B.h - 68) / (leftOrder.length - 1)); });
  rightOrder.forEach((k, i) => { R[k] = B.y + 26 + i * ((B.h - 52) / (rightOrder.length - 1)); });

  const LBL = { 13:'D13', 14:'D14', 26:'D26', 25:'D25', 32:'D32', 33:'D33',
                34:'D34', 35:'D35', 36:'VP', 39:'VN', 16:'RX2', 17:'TX2',
                18:'D18', 19:'D19', 21:'D21', 22:'D22', 23:'D23', 27:'D27' };

  BINS.forEach((binClass, i) => {
    const m = META[binClass], p = PINS[m.key], y = SCH.rows[i];
    const { s, live, full, lidOpen } = binView(binClass);
    const fill = live ? s.fill : 0;
    const tone = m.key === 'bio' ? '#4ade80' : m.key === 'rec' ? '#38bdf8' : '#f97316';

    // ── HC-SR04 on the left, with the measured fill drawn inside a bin body
    const ux = SCH.usX;
    parts.push(`
      <g class="part">
        <rect x="${ux}" y="${y - 34}" width="150" height="52" rx="7" class="chip"/>
        <circle cx="${ux + 38}" cy="${y - 8}" r="16" class="xducer"/>
        <circle cx="${ux + 112}" cy="${y - 8}" r="16" class="xducer"/>
        <text x="${ux + 75}" y="${y + 12}" class="chipTxt" text-anchor="middle">HC-SR04</text>
        <rect x="${ux + 20}" y="${y + 30}" width="110" height="78" rx="6" class="binBody"/>
        <rect x="${ux + 24}" y="${y + 104 - (fill / 100) * 70}" width="102"
              height="${(fill / 100) * 70}" rx="4" fill="${tone}" opacity=".55"/>
        <text x="${ux + 75}" y="${y + 126}" class="chipSub" text-anchor="middle">
          ${m.short} ${live ? s.fill + '%' : '—'}${full ? ' FULL' : ''}</text>
      </g>`);
    wires.push(wire(leftX, L[m.key + 'Trig'], ux + 150, y - 18, WIRE.sig, !live));
    wires.push(wire(leftX, L[m.key + 'Echo'], ux + 150, y + 2,  WIRE.sig, !live));
    pads.push(pad(leftX, L[m.key + 'Trig'], LBL[p.trig], 'left'));
    pads.push(pad(leftX, L[m.key + 'Echo'], LBL[p.echo], 'left'));

    // ── servo on the right, horn swinging to the open angle
    const sx = SCH.servoX, ang = lidOpen ? -38 : 0;
    parts.push(`
      <g class="part">
        <rect x="${sx}" y="${y - 26}" width="86" height="52" rx="6" class="chip"/>
        <circle cx="${sx + 86}" cy="${y}" r="13" class="xducer"/>
        <g transform="rotate(${ang} ${sx + 86} ${y})">
          <rect x="${sx + 84}" y="${y - 3}" width="46" height="6" rx="3"
                fill="${lidOpen ? '#4ade80' : '#5a6472'}"/>
        </g>
        <text x="${sx + 43}" y="${y + 4}" class="chipTxt" text-anchor="middle">SG90</text>
        <text x="${sx + 43}" y="${y + 44}" class="chipSub" text-anchor="middle">
          ${lidOpen ? 'UNLOCKED' : 'locked'}</text>
      </g>`);
    wires.push(wire(rightX, R[m.key + 'Servo'], sx, y - 8, WIRE.pwm, !live));
    pads.push(pad(rightX, R[m.key + 'Servo'], LBL[p.servo], 'right'));

    // ── the two status LEDs
    const redOn = full || !live, greenOn = live && !full;
    [['Red', redOn, '#f87171', y - 16], ['Green', greenOn, '#4ade80', y + 20]].forEach(([nm, on, col, ly]) => {
      parts.push(`
        <g class="part">
          <circle cx="${SCH.ledX}" cy="${ly}" r="11"
                  fill="${on ? col : '#151b26'}" stroke="${on ? col : '#2b323e'}" stroke-width="2"
                  ${on ? `filter="url(#glow)"` : ''}/>
          <text x="${SCH.ledX + 20}" y="${ly + 4}" class="chipSub">${nm.toUpperCase()}</text>
        </g>`);
      wires.push(wire(rightX, R[m.key + nm], SCH.ledX - 11, ly, col, !on));
      pads.push(pad(rightX, R[m.key + nm], LBL[nm === 'Red' ? p.red : p.green], 'right'));
    });
  });

  // ── shared: gas potentiometer and the two fallback buttons
  const anyGas = BINS.map((b) => state.bins[META[b].key].gas).find((g) => g != null);
  parts.push(`
    <g class="part">
      <circle cx="${SCH.potX}" cy="${SCH.potY}" r="26" class="chip"/>
      <line x1="${SCH.potX}" y1="${SCH.potY}" x2="${SCH.potX}" y2="${SCH.potY - 20}"
            stroke="#c084fc" stroke-width="3" stroke-linecap="round"
            transform="rotate(${anyGas != null ? (anyGas / 4095) * 270 - 135 : -135} ${SCH.potX} ${SCH.potY})"/>
      <text x="${SCH.potX}" y="${SCH.potY + 46}" class="chipSub" text-anchor="middle">
        MQ-135 ${anyGas != null ? anyGas : '—'}</text>
    </g>`);
  wires.push(wire(leftX, L.gas, SCH.potX + 26, SCH.potY, WIRE.adc, anyGas == null));
  pads.push(pad(leftX, L.gas, 'VN', 'left'));

  [['btnBin', 27, 'BIN', 300], ['btnItem', 23, 'PRESENT', 400]].forEach(([k, g, lbl, bx]) => {
    parts.push(`
      <g class="part">
        <rect x="${bx}" y="${SCH.btnY - 16}" width="62" height="32" rx="7" class="chip"/>
        <circle cx="${bx + 31}" cy="${SCH.btnY}" r="9" fill="#2b3442" stroke="#465063" stroke-width="2"/>
        <text x="${bx + 31}" y="${SCH.btnY + 32}" class="chipSub" text-anchor="middle">${lbl}</text>
      </g>`);
    wires.push(wire(leftX, L[k], bx + 62, SCH.btnY, WIRE.sig, true));
    pads.push(pad(leftX, L[k], LBL[g], 'left'));
  });

  // ── rails
  wires.push(wire(leftX, L.gndL, SCH.potX, SCH.potY + 26, WIRE.gnd, true));
  wires.push(wire(rightX, R.vin, SCH.servoX, SCH.rows[1] + 20, WIRE.pwr, true));
  wires.push(wire(rightX, R.gndR, SCH.ledX - 11, SCH.rows[2] + 40, WIRE.gnd, true));
  pads.push(pad(leftX, L.gndL, 'GND', 'left'));
  pads.push(pad(rightX, R.vin, 'VIN', 'right'));
  pads.push(pad(rightX, R.gndR, 'GND', 'right'));

  const connected = !!state.client?.connected;
  el.schematic.innerHTML = `
  <svg viewBox="0 0 ${SCH.w} ${SCH.h}" class="schSvg" role="img"
       aria-label="Wiring diagram of the ESP32 station controller">
    <defs>
      <filter id="glow" x="-90%" y="-90%" width="280%" height="280%">
        <feGaussianBlur stdDeviation="4.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    ${wires.join('')}
    <rect x="${B.x}" y="${B.y}" width="${B.w}" height="${B.h}" rx="12" class="board"/>
    <rect x="${B.x + 22}" y="${B.y + 150}" width="${B.w - 44}" height="150" rx="5" class="boardChip"/>
    <text x="${B.x + B.w / 2}" y="${B.y + 232}" class="boardTxt" text-anchor="middle">ESP32</text>
    <text x="${B.x + B.w / 2}" y="${B.y + 252}" class="boardSub" text-anchor="middle">DEVKIT V1</text>
    <text x="${B.x + B.w / 2}" y="${B.y - 14}" class="boardSub" text-anchor="middle">
      STATION 01 · ${connected ? 'LINKED' : 'OFFLINE'}</text>
    ${pads.join('')}
    ${parts.join('')}
  </svg>`;
}

function renderCircuitCards() {
  el.circuitCards.innerHTML = '';
  for (const binClass of BINS) {
    const { m, s, seen, stale, live, full, lidOpen } = binView(binClass);
    const p = PINS[m.key];
    const card = document.createElement('div');
    card.className = 'binCard binCard--static'
      + (stale || !seen ? ' binCard--stale' : '') + (full ? ' binCard--full' : '');
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
          <span class="stat__v ${full ? 'stat__v--bad' : ''}">${live ? s.fill + '%' : '—'}</span></div>
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
  if (state.view === 'station') renderBinCards();
  else updateHeader();
  if (state.view === 'circuit') { renderSchematic(); renderCircuitCards(); }
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
    if (doc.event === 'ACCEPT') { s.lidOpenUntil = Date.now() + LID_OPEN_MS; s.collected++; }
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

function publishManual(label) {
  if (!state.targetBin) { log('Open a bin first', 'err'); return; }
  publish({
    class: label, confidence: 1, target: SHORT[state.targetBin],
    source: 'manual', ts: Math.floor(Date.now() / 1000),
  }, 'manual override');
}

/* ── wiring ───────────────────────────────────────────────────────────── */

el.binCards.addEventListener('click', (e) => {
  const card = e.target.closest('.binCard');
  if (!card?.dataset.bin) return;
  // A full bin refuses everything, so opening its camera would only mislead.
  if (card.classList.contains('binCard--full')) {
    log(`${card.dataset.bin} is full — empty it before scanning`, 'err');
    return;
  }
  openScanner(card.dataset.bin);
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
el.clearLog.addEventListener('click', () => { el.log.innerHTML = ''; });
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
  applyProviderVisibility();
  renderBars();
  renderVerdict();
  renderAll();
  if (location.protocol === 'file:') {
    log('Opened via file:// — the camera will be blocked. Run serve.bat and use http://localhost:8000', 'err');
  }
  await listCameras();
  await loadServerStatus();
  connect();
  await initModel();
})();
