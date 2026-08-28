/* Smart Waste Management — classifier node.
 *
 * Runs a 3-class waste classifier on the webcam and publishes the result over
 * MQTT. The ESP32 station controller subscribes and decides whether to unlock
 * the lid; this page mirrors the expected decision so the operator sees it too.
 *
 * Three swappable classifiers, chosen at runtime:
 *
 *   gemini     Cloud vision. Best accuracy on real, deformed, dirty waste and
 *              needs no training. Implements the "image uploads from the
 *              ESP32-CAM" path the project document already specifies (p9).
 *              On-demand only: the free tier allows 5-15 requests/minute.
 *   teachable  Teachable Machine model in ./model/. Runs offline at ~5fps.
 *              This is the demo-safe fallback when the network dies.
 *   mobilenet  Stock ImageNet model plus a crude keyword map. Present only so
 *              the page does something before either of the above is set up.
 *
 * The Gemini key is entered at runtime and kept in localStorage. It is never
 * written to a file in this repository.
 */

const BINS = ['BIODEGRADABLE', 'RECYCLABLE', 'NON_RECYCLABLE'];
const SHORT = { BIODEGRADABLE: 'BIO', RECYCLABLE: 'REC', NON_RECYCLABLE: 'NON' };

const INFER_MS = 200;    // inference cadence
const STABLE_MS = 1500;  // how long a class must hold before auto-present fires
const COOLDOWN_MS = 3000; // minimum gap between auto-presents

/* Keyword heuristic mapping ImageNet's 1000 labels onto three waste bins.
 * Deliberately crude. It exists so the page is usable before a model is
 * trained, and it is labelled as a heuristic in the UI so nobody mistakes it
 * for a waste-trained model. Replace it by dropping a real model in ./model/. */
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

const $ = (s) => document.querySelector(s);
const el = {
  cam: $('#cam'), camOverlay: $('#camOverlay'), startCam: $('#startCam'),
  stopCam: $('#stopCam'), camSelect: $('#camSelect'),
  bins: $('#bins'), bars: $('#bars'), verdict: $('#verdict'),
  verdictItem: $('#verdictItem'),
  present: $('#present'), autoPresent: $('#autoPresent'),
  log: $('#log'), clearLog: $('#clearLog'),
  modelPill: $('#modelPill'), mqttPill: $('#mqttPill'),
  cfgProvider: $('#cfgProvider'), cfgKey: $('#cfgKey'), cfgGeminiModel: $('#cfgGeminiModel'),
  cfgBroker: $('#cfgBroker'), cfgTopic: $('#cfgTopic'), cfgConf: $('#cfgConf'),
  reconnect: $('#reconnect'),
};

const state = {
  classifier: null,   // { kind, mode, detail, predict(video) -> [{label,p}] }
  stream: null,
  targetBin: null,
  latest: [],         // last prediction, sorted desc
  note: null,         // free-text explanation from the provider, if any
  busy: false,
  stableSince: 0,
  stableLabel: null,
  lastAutoPublish: 0,
  client: null,
  inferTimer: null,
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
  while (el.log.children.length > 120) el.log.lastChild.remove();
}

function pill(node, text, kind) {
  node.textContent = text;
  node.className = `pill pill--${kind}`;
}

/* ── model ────────────────────────────────────────────────────────────── */

function normaliseLabel(raw) {
  const s = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (BINS.includes(s)) return s;
  if (/^(BIO|ORGANIC|COMPOST)/.test(s)) return 'BIODEGRADABLE';
  if (/^(REC|RECYCLE)/.test(s)) return 'RECYCLABLE';
  if (/^(NON|RESIDUAL|TRASH|GENERAL)/.test(s)) return 'NON_RECYCLABLE';
  return null; // unknown label from a custom model — surfaced as-is
}

/** Grab the current video frame as a base64 JPEG, downscaled to cap upload size. */
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

const GEMINI_PROMPT = `You are the waste classification module of a smart segregation bin in the Philippines.

Identify the single most prominent waste item a person is holding up to the bin and classify it into exactly one category:

- BIODEGRADABLE: food scraps, fruit and vegetable peel, garden waste, soiled paper napkins, anything that will rot.
- RECYCLABLE: clean plastic bottles and containers, glass, metal cans, clean paper, cardboard.
- NON_RECYCLABLE: sachets and multilayer film, styrofoam, nappies, cigarette butts, broken ceramics, contaminated or mixed-material packaging.
- NO_MATCH: no clear waste item is being presented, the image is too blurred or dark, or you genuinely cannot tell.

Return NO_MATCH rather than guessing. Contamination downgrades an item: a grease-soaked pizza box is BIODEGRADABLE, not RECYCLABLE.

confidence is your own certainty from 0 to 1. item is a two-or-three word name for what you see. reason is one short sentence a student could read aloud during a demonstration.`;

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
              { text: GEMINI_PROMPT },
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

      const label = out.class === 'NO_MATCH' ? 'NO_MATCH' : (normaliseLabel(out.class) || 'NO_MATCH');
      const p = Math.max(0, Math.min(1, Number(out.confidence) || 0));
      state.note = out.item ? `${out.item} — ${out.reason}` : out.reason;

      // Present the winner plus the remaining mass spread over the others, so
      // the bars stay readable even though Gemini returns a single verdict.
      const rest = BINS.filter((b) => b !== label);
      return [
        { label, p },
        ...rest.map((b) => ({ label: b, p: (1 - p) / rest.length })),
      ];
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
          if (IMAGENET_MAP[bin].some((kw) => name.includes(kw))) {
            acc[bin] += r.probability;
            break;
          }
        }
      }
      const total = BINS.reduce((s, b) => s + acc[b], 0);
      if (total === 0) return BINS.map((b) => ({ label: b, p: 0 }));
      return BINS.map((b) => ({ label: b, p: acc[b] / total }))
        .sort((a, b) => b.p - a.p);
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
    if (want === 'gemini') {
      state.classifier = loadGemini();
      pill(el.modelPill, `model: ${state.classifier.detail}`, el.cfgKey.value.trim() ? 'ok' : 'warn');
      log(el.cfgKey.value.trim()
        ? `${state.classifier.detail} ready — press Present item to classify`
        : 'Gemini selected but no API key yet. Paste one below.', el.cfgKey.value.trim() ? 'ok' : 'err');
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
    const hint = want === 'teachable'
      ? 'Put an exported Teachable Machine model in classifier/model/.'
      : 'MobileNet needs internet on first load.';
    log(`Model load failed: ${e.message}. ${hint}`, 'err');
    return;
  }

  if (state.stream) startInference();
  renderVerdict();
}

/* ── camera ───────────────────────────────────────────────────────────── */

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
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
    const deviceId = el.camSelect.value;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
    });
    el.cam.srcObject = state.stream;
    await el.cam.play();
    el.camOverlay.hidden = true;
    el.stopCam.disabled = false;
    el.present.disabled = false;
    await listCameras();
    log('Camera started', 'ok');
    startInference();
  } catch (e) {
    log(`Camera failed: ${e.message}`, 'err');
  }
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.cam.srcObject = null;
  el.camOverlay.hidden = false;
  el.stopCam.disabled = true;
  el.present.disabled = true;
  clearInterval(state.inferTimer);
  state.inferTimer = null;
  state.latest = [];
  renderBars();
  renderVerdict();
  log('Camera stopped');
}

/* ── inference ────────────────────────────────────────────────────────── */

function startInference() {
  clearInterval(state.inferTimer);
  state.inferTimer = null;
  // On-demand providers (Gemini) are metered and rate-limited, so they are
  // driven by the Present item button rather than a timer.
  if (state.classifier?.mode !== 'continuous') return;
  state.inferTimer = setInterval(async () => {
    if (!state.classifier || !state.stream || el.cam.readyState < 2) return;
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

/** One classification on demand, then publish it. Used by on-demand providers. */
async function classifyOnce(note) {
  if (state.busy) return;
  if (!state.classifier) { log('No classifier loaded', 'err'); return; }
  if (!state.stream || el.cam.readyState < 2) { log('Camera is not running', 'err'); return; }
  if (!state.targetBin) { log('Pick a target bin first', 'err'); return; }

  state.busy = true;
  el.present.disabled = true;
  const original = el.present.textContent;
  el.present.textContent = 'Classifying…';
  pill(el.modelPill, `model: ${state.classifier.detail} · working`, 'warn');
  try {
    state.latest = await state.classifier.predict(el.cam);
    renderBars();
    renderVerdict();
    pill(el.modelPill, `model: ${state.classifier.detail}`, 'ok');
    publishClassification(note);
  } catch (e) {
    pill(el.modelPill, `model: ${state.classifier.detail} · error`, 'bad');
    log(`Classification failed: ${e.message}`, 'err');
  } finally {
    state.busy = false;
    el.present.textContent = original;
    el.present.disabled = !state.stream;
  }
}

function threshold() {
  const v = parseFloat(el.cfgConf.value);
  return Number.isFinite(v) ? v : 0.7;
}

/** The decision the ESP32 is expected to reach, mirrored for the operator. */
function decide() {
  if (!state.targetBin) return { verdict: 'IDLE', why: 'Pick the bin the item is presented to' };
  if (!state.latest.length) return { verdict: 'IDLE', why: 'Waiting for the camera' };
  const top = state.latest[0];
  if (top.label === 'NO_MATCH') {
    return {
      verdict: 'NO MATCH', kind: 'nomatch', reason: 'no_item',
      why: 'No identifiable waste item presented — lid stays locked',
    };
  }
  if (top.p < threshold()) {
    return {
      verdict: 'NO MATCH', kind: 'nomatch', reason: 'low_confidence',
      why: `Best guess ${top.label} at ${(top.p * 100).toFixed(0)}%, below ${(threshold() * 100).toFixed(0)}% — lid stays locked`,
    };
  }
  if (top.label !== state.targetBin) {
    return {
      verdict: 'REJECT', kind: 'reject', reason: 'class_mismatch',
      why: `Detected ${top.label} at the ${SHORT[state.targetBin]} bin — lid stays locked`,
    };
  }
  return {
    verdict: 'ACCEPT', kind: 'accept', reason: null,
    why: `${top.label} at ${(top.p * 100).toFixed(0)}% matches this bin — lid unlocks`,
  };
}

function trackStability() {
  const top = state.latest[0];
  if (!top) return;
  if (top.label !== state.stableLabel) {
    state.stableLabel = top.label;
    state.stableSince = Date.now();
    return;
  }
  if (!el.autoPresent.checked) return;
  const now = Date.now();
  const held = now - state.stableSince;
  if (held >= STABLE_MS && now - state.lastAutoPublish >= COOLDOWN_MS) {
    if (decide().verdict !== 'IDLE') {
      state.lastAutoPublish = now;
      publishClassification('auto');
    }
  }
}

/* ── rendering ────────────────────────────────────────────────────────── */

function renderBars() {
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
  el.verdict.className = `verdict verdict--${d.kind || 'idle'}`;
  el.verdict.querySelector('.verdict__label').textContent = d.verdict;
  el.verdict.querySelector('.verdict__why').textContent = d.why;
  el.verdictItem.textContent = state.note || '';
  el.verdictItem.hidden = !state.note;
}

/* ── MQTT ─────────────────────────────────────────────────────────────── */

function connect() {
  if (state.client) { try { state.client.end(true); } catch {} state.client = null; }
  const url = el.cfgBroker.value.trim();
  pill(el.mqttPill, 'broker: connecting…', 'warn');
  log(`Connecting to ${url}`);
  try {
    state.client = mqtt.connect(url, {
      clientId: `swm-classifier-${Math.random().toString(16).slice(2, 10)}`,
      connectTimeout: 8000,
      reconnectPeriod: 4000,
      clean: true,
    });
  } catch (e) {
    pill(el.mqttPill, 'broker: bad URL', 'bad');
    log(`Connect failed: ${e.message}`, 'err');
    return;
  }
  state.client.on('connect', () => {
    pill(el.mqttPill, 'broker: connected', 'ok');
    log('Broker connected', 'ok');
  });
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
  if (!state.client?.connected) {
    log(`OFFLINE, not sent: ${body}`, 'err');
    return;
  }
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
  if (!state.targetBin) { log('Pick a target bin first', 'err'); return; }
  publish({
    class: label,
    confidence: 1,
    target: SHORT[state.targetBin],
    source: 'manual',
    ts: Math.floor(Date.now() / 1000),
  }, 'manual override');
}

/* ── wiring ───────────────────────────────────────────────────────────── */

el.bins.addEventListener('click', (e) => {
  const btn = e.target.closest('.bin');
  if (!btn) return;
  state.targetBin = btn.dataset.bin;
  [...el.bins.children].forEach((b) =>
    b.setAttribute('aria-checked', String(b === btn)));
  renderVerdict();
});

el.startCam.addEventListener('click', startCamera);
el.stopCam.addEventListener('click', stopCamera);
el.camSelect.addEventListener('change', () => { if (state.stream) { stopCamera(); startCamera(); } });
el.clearLog.addEventListener('click', () => { el.log.innerHTML = ''; });
el.reconnect.addEventListener('click', connect);
document.querySelectorAll('[data-manual]').forEach((b) =>
  b.addEventListener('click', () => publishManual(b.dataset.manual)));

el.present.addEventListener('click', () => {
  if (state.classifier?.mode === 'continuous') publishClassification('present');
  else classifyOnce('present');
});

/* Settings persistence. The API key lives in localStorage on this machine only
 * and is deliberately never written to a file in the repository. */
const SAVED = ['cfgProvider', 'cfgGeminiModel', 'cfgKey', 'cfgConf', 'cfgBroker', 'cfgTopic'];

function applyProviderVisibility() {
  const gemini = el.cfgProvider.value === 'gemini';
  document.querySelectorAll('.geminiOnly').forEach((n) => { n.hidden = !gemini; });
  el.autoPresent.disabled = gemini;
  el.autoPresent.parentElement.title = gemini
    ? 'Disabled for Gemini — the free tier allows only 5-15 requests per minute'
    : '';
  if (gemini) el.autoPresent.checked = false;
}

function restoreSettings() {
  for (const id of SAVED) {
    try {
      const v = localStorage.getItem(`swm.${id}`);
      if (v !== null) el[id].value = v;
    } catch { /* private mode or blocked storage — defaults are fine */ }
  }
}

for (const id of SAVED) {
  el[id].addEventListener('change', () => {
    try { localStorage.setItem(`swm.${id}`, el[id].value); } catch {}
  });
}

el.cfgProvider.addEventListener('change', () => { applyProviderVisibility(); initModel(); });
el.cfgGeminiModel.addEventListener('change', () => {
  if (el.cfgProvider.value === 'gemini') initModel();
});
el.cfgKey.addEventListener('change', () => {
  if (el.cfgProvider.value === 'gemini') initModel();
});

(async function main() {
  restoreSettings();
  applyProviderVisibility();
  renderBars();
  renderVerdict();
  if (location.protocol === 'file:') {
    log('Opened via file:// — the camera will be blocked. Run serve.bat and use http://localhost:8000', 'err');
  }
  await listCameras();
  connect();
  await initModel();
})();
