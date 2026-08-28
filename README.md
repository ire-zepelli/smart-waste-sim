# Zura — Smart Waste Bins

Prototype / simulation for the IT-Elective 3 project (BSIT 4D, University of
Cebu LM). This is **outline item #9**, which the project document lists but
never delivered.

Two halves joined by real MQTT:

```
  browser (your laptop)                    Wokwi (real ESP32 firmware)
  ┌────────────────────────┐               ┌────────────────────────┐
  │ tap a bin → camera     │  MQTT over ws │ 3 × HC-SR04  fill      │
  │ Groq / Gemini decides  │ ─────────────▶│ 3 × servo    lid lock  │
  │ BIO / REC / NON        │ broker.hivemq │ 6 × LED      status    │
  │                        │◀───────────── │ 1 × pot      gas       │
  │ bins show live state   │   telemetry   └────────────────────────┘
  └────────────────────────┘
```

## 1. Run the web app

```
classifier\serve.bat
```

It opens `http://localhost:8000` for you. **Do not open `index.html`
directly** — Chrome blocks camera access on `file://`.

> `serve.bat` runs `serve.py`, which binds dual-stack on purpose. Windows
> resolves `localhost` to `::1` before `127.0.0.1`, and an IPv4-only server
> makes the browser fail with `ERR_EMPTY_RESPONSE` even though
> `http://127.0.0.1:8000` works. It also sends no-cache headers so your edits
> show up on reload.

## 2. Pick a classifier

Settings bar along the bottom of the page.

| Provider | Model | Needs | Notes |
| --- | --- | --- | --- |
| **Groq** (default) | `qwen/qwen3.8-27b` | free key from [console.groq.com](https://console.groq.com/keys) | Verified working. On-demand only. |
| **Gemini** | `gemini-2.5-flash` | free key from [aistudio.google.com](https://aistudio.google.com) | Free tier is 5–15 requests/min. |
| **Teachable Machine** | your own | an exported model in `classifier\model\` | Runs offline at ~5 fps. Use this if the venue has no wifi. |
| **MobileNet heuristic** | — | internet on first load | Placeholder only, labelled untrained in the UI. |

### Where the key comes from

`serve.py` looks for a dotenv-style file and, if it finds one, **proxies every
vision call through the local server so the key never reaches the browser at
all.** Nothing to paste, and nothing to leak through devtools or a screen share.

It checks, first hit wins:

1. `--env-file PATH`
2. `$ZURA_ENV_FILE`
3. `$GROQ_API_KEY` / `$GEMINI_API_KEY`
4. `smart-waste-sim/.env`, then
   `%USERPROFILE%\OneDrive\Documents\personal-shi\access-token.env`

Accepted variable names are `groq` / `GROQ_API_KEY` and
`gemini` / `GEMINI_API_KEY`. On start-up the console prints which providers it
found and where from — names only, never values. Confirm with:

```
curl http://localhost:8000/api/status
```

If no key is found the page falls back to the **API key** field in the settings
bar, stored in `localStorage` per provider. That path works from any static
server but does put the key in the browser, so prefer the proxy.

**No key is ever written to a file in this repository**, and `*.env` is
gitignored. The proxy refuses non-loopback callers — never expose it publicly,
it is an unauthenticated hole to your quota.

Do **not** move the Groq model back to `qwen/qwen3.6-27b` — it fails JSON
validation. Llama 4 Scout and Maverick are not available on the free tier.

## 3. Run the bin controller

Open [wokwi.com](https://wokwi.com) → new ESP32 project, then paste in:

| File | Where it goes |
| --- | --- |
| `firmware/smart_bin.ino` | the sketch tab |
| `firmware/diagram.json` | the diagram tab |
| `firmware/libraries.txt` | the library manager |

Press play. The serial monitor shows the connection and every decision.

> `diagram.json` uses `board-esp32-devkit-v1`. If you start from a
> `devkit-c-v4` project the pin labels differ and the wiring will not match.

## 4. Demonstrate

**With the camera:** tap a bin → its camera opens → hold an item up → press
**Scan Item**. A match unlocks that bin's lid and lights its green LED; a
mismatch keeps it locked and lights red. The model's one-line reason appears
under the button.

Drag any HC-SR04's distance slider in Wokwi to change fill level. Past 85% the
bin reports FULL, refuses everything, and stops being tappable.

**Without a camera:** *Camera not working? Override manually* inside the scan
modal publishes a classification with no camera and no model.

**Without a network:** use the Wokwi buttons.

- **GPIO27** — change which bin is being approached
- **GPIO23** — present an item, cycling BIO → REC → NON each press

Three presses on any bin therefore show reject, accept, reject in order.

## 5. Watch the telemetry

The **Circuit** tab shows per-bin pin assignments, live fill, gas, lid state,
the last admission event, and raw MQTT traffic.

For an external view, open the
[HiveMQ web client](https://www.hivemq.com/demos/websocket-client/) and
subscribe to `uc-swm-4d/station01/#`.

## Layout

```
classifier/    the web app
  index.html   bins → scan modal → circuit tab
  app.js       classifiers, MQTT, views
  serve.py     dual-stack static server
  vendor/      TF.js, Teachable Machine, MQTT.js, MobileNet (offline copies)
  model/       drop an exported Teachable Machine model here
firmware/      ESP32 station controller for Wokwi
docs/          design spec
```

## Honesty notes for the paper

- Classification runs on the laptop, not on an ESP32-CAM. This matches the
  cloud-upload path the project document specifies on p9, but not the
  on-device Edge ML path on p11.
- One ESP32 controls all three bins; the hardware list implies one per bin.
- One camera plus a bin selector stands in for three separate intake scanners.
- The public MQTT broker has no authentication and no TLS.
- Wokwi does not model power draw, so the "intermittent resets from solenoid
  spikes" entry in the troubleshooting guide cannot be reproduced.

Full detail in `docs/superpowers/specs/2026-08-28-smart-waste-simulation-design.md` §8.
