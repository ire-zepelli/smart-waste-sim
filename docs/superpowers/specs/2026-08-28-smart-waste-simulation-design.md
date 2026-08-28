# Smart Waste Management — Prototype / Simulation Design

**Date:** 2026-08-28
**Course:** IT-Elective 3, BSIT 4D, University of Cebu LM
**Fills:** Outline item #9 (Prototype or Simulation), currently absent from the project document
**Source document:** `Smart waste management.pdf` (13 pp.)

---

## 1. Purpose

Demonstrate the two headline mechanisms of the proposed system without purchasing hardware:

1. **Segregation admission control** — a camera classifies the presented item; the lid unlocks only on a category match.
2. **Fill-level monitoring with cloud telemetry** — ultrasonic depth sensing drives external indicators and publishes alerts.

The simulation must exercise every branch of the programming flowchart (source p8) and satisfy the three verification steps the document already commits to (source p13).

## 2. Scope

**In scope**

- A real, trained 3-class image classifier running on a laptop webcam
- Wokwi ESP32 firmware acting as station controller for three bin units
- Real MQTT carrying classification results and telemetry between them
- Reproducible failure scenarios matching the document's troubleshooting guide (p13)
- A drop-in written section for the project document

**Out of scope**

- On-device classification on real ESP32-CAM hardware
- The route optimization engine (p4 diagram, cloud layer)
- Any physical hardware purchase
- Production authentication, TLS, or broker hardening

## 3. Architecture

Two halves mirroring the architecture diagram (p4), joined by real MQTT.

| Block in the p4 diagram | What runs it in the simulation |
| --- | --- |
| Object Classification (AI/Vision/Sensors) | Teachable Machine model, TensorFlow.js, laptop webcam |
| Smart Waste Bins layer (sensors + actuators) | Wokwi ESP32 with real firmware |
| Connectivity → Edge Gateway → Internet | Wokwi virtual WiFi gateway → `broker.hivemq.com` |
| Message Broker (MQTT/HTTP) | HiveMQ public broker |
| Municipal Waste Dashboard | HiveMQ web client subscribed to the project topics |

### Accepted deviations from the source document

Both must be stated explicitly in the project document rather than passing silently — a panel that discovers an unstated simplification treats it as an error, whereas a declared one reads as engineering judgement.

**One controller, not three.** The hardware list (p5, item 7) implies one ESP32 per bin unit. This design uses **one ESP32 as a station controller for all three bin units**. It demonstrates identical control logic, halves the wiring, and "one controller per station" is defensible in its own right.

**One camera, not three.** The proposed system gives every bin its own intake scanner. The simulation has a single webcam plus an on-screen **target bin** selector standing in for "which bin the user walked up to". The admission logic being tested — does the detected class match *this* bin's category — is identical; only the number of camera instances differs.

### Correction this design forces

The network diagram (p10) shows bins communicating directly with the Cloud Server, omitting the Edge Gateway and contradicting the p9 text. This design routes bins → gateway hop → broker, matching the **text**. The p10 diagram should be corrected to match.

## 4. Components

### C1 — Classifier page (`classifier/index.html`)

Single page, no build step, served over `http://localhost`. **Four swappable classifiers**, selected at runtime:

| Provider | Model | Mode | Notes |
| --- | --- | --- | --- |
| **Groq** (default) | `qwen/qwen3.8-27b` | on-demand | Verified against the live API. Best accuracy on real, deformed, contaminated waste. No training. |
| **Gemini** | `gemini-2.5-flash` | on-demand | Equivalent capability; free tier is 5–15 req/min. |
| **Teachable Machine** | user-supplied | continuous ~5 fps | Loads from `classifier/model/`. Runs fully offline — the demo-safe fallback. |
| **MobileNet heuristic** | stock ImageNet | continuous | Crude keyword map. Present only so the page does something before the others are configured. Labelled untrained in the UI. |

**Navigation.** Three surfaces: a **station** view of the three bins, a **scan modal** opened by tapping one, and a **circuit** tab. The bin being scanned is established by which card was tapped, mirroring the physical system where the target is implicit in which bin you walk up to. A bin at or above the full threshold is not tappable, since it would refuse everything.

Common behaviour:

- Three classes: `BIODEGRADABLE`, `RECYCLABLE`, `NON_RECYCLABLE`, plus `NO_MATCH`
- Live webcam preview inside the scan modal
- Confidence threshold of **0.70**; below it the result is `NO_MATCH`, never a guess
- The provider's one-line reason is rendered under the scan button — the most demonstrable part of the system, and the thing a panel will ask about
- Per-bin collected counts and a station total, both derived from real `ACCEPT` events, never simulated locally
- Publishes over MQTT WebSocket to `ws://broker.hivemq.com:8000/mqtt`, and subscribes to telemetry
- Connection status indicator; explicit "not connected" state, never a silent failure
- Manual override buttons that publish a classification with no camera and no model at all

**Why a cloud classifier is the default.** The project document already specifies this path: p9 states the 4G LTE/5G modem "offers high-bandwidth connectivity for areas requiring faster data transfer and image uploads from the ESP32-CAM," and hardware item 15 repeats it. Cloud classification is therefore the branch the design already documented. It also removes the weakest part of a student prototype — a model trained on fifty photographs of one bottle.

**Verified facts about the two cloud providers.** Each was established by calling the live API, not from documentation or recall:

| | Groq | Gemini |
| --- | --- | --- |
| Endpoint | `api.groq.com/openai/v1/chat/completions` | `generativelanguage.googleapis.com/v1beta` |
| Browser callable | Yes — returns `access-control-allow-origin: *` | Yes, using `?key=` |
| Auth | `Authorization: Bearer` header | `?key=` query param |
| Working vision model | `qwen/qwen3.8-27b` | `gemini-2.5-flash` |
| Structured output | `response_format: {type: json_object}` | `responseMimeType` + explicit `responseSchema` |

Three traps worth recording, each of which cost a round trip to find:

1. **Gemini rejects the `x-goog-api-key` header from a browser** — the custom header triggers a CORS preflight the endpoint refuses. The `?key=` query form avoids the preflight entirely.
2. **Llama 4 Scout and Maverick 404 on Groq's free tier** despite being the models its documentation showcases. The account exposes 14 models and neither is among them.
3. **`qwen/qwen3.6-27b` fails JSON validation** even in JSON mode, because it emits reasoning before the object. Only 3.8 is safe. The model name is an editable field so a rename cannot kill a demonstration, but it must not be moved back to 3.6.

**Rate limits shape the interaction.** Every classification is a metered API call, so it is fired by the *Scan Item* button and never by a timer. Auto-present is disabled whenever a cloud provider is selected. Gemini's free tier is roughly 5–15 requests/minute and ~1,000/day.

**Key handling — proxied by default.** `serve.py` reads a dotenv-style file and proxies `/api/classify` to the provider with the key attached server-side. **The browser never receives the key**, so it cannot leak through devtools, a screenshot, or a screen share during the demonstration. The page discovers this via `GET /api/status`, which reports only *which* providers have a key and the file it came from, never a value. The proxy refuses non-loopback callers, because an open proxy is an unauthenticated hole to the quota.

The direct-from-browser path remains as a fallback for when the page is served by something other than `serve.py`: a key typed into the settings bar, held in `localStorage` **per provider** so switching between Groq and Gemini cannot send one provider's key to the other. That path does expose the key to anyone using the page, and the UI says so.

No key is ever written to a file in this repository, and `*.env` is gitignored.

**Constraint driving the localhost requirement:** Chrome refuses `getUserMedia` on `file://` because it is not a secure context. `http://localhost` qualifies as secure, and keeps plain `ws://` legal — HTTPS would force `wss://` on port 8884 as mixed-content protection. A `serve.bat` wrapping `python -m http.server 8000` handles this; Python 3.13 is already installed on the target machine.

**This page cannot be published as a hosted artifact** — the artifact sandbox blocks outbound connections to external hosts, which kills the MQTT link.

### C2 — Firmware (`firmware/smart_bin.ino`)

State machine implementing the p8 flowchart exactly, for three bin units.

Constants:

| Name | Value | Note |
| --- | --- | --- |
| `BIN_DEPTH_CM` | 40 | Empty-to-floor distance; fill% = `(40 - d) / 40 × 100` |
| `FULL_THRESHOLD_PCT` | 85 | Above this the bin reports `FULL` |
| `TELEMETRY_INTERVAL_MS` | 5000 | Demo-friendly; production would be minutes |
| `CLASSIFY_TTL_MS` | 5000 | Classification results older than this are discarded |
| `CONFIDENCE_MIN` | 0.70 | Mirrors the classifier page |

Behaviour:

- Subscribes to the classification topic, publishes telemetry and events
- Accepts classification from **either** MQTT **or** three physical pushbuttons, selectable at runtime
- Median-of-5 filter on ultrasonic readings; discards values outside 2–400 cm
- Exponential backoff on MQTT reconnect, capped at 30 s

**`CLASSIFY_TTL_MS` is a safety requirement, not a nicety.** Without it, a stale `ACCEPT` sitting in the broker could unlock a bin minutes after the item was withdrawn.

### C3 — Wokwi circuit (`firmware/diagram.json`)

Parts: `wokwi-esp32-devkit-v1`, 3× `wokwi-hc-sr04`, 3× `wokwi-servo`, 6× `wokwi-led` + resistors, 1× `wokwi-potentiometer` (MQ-135 stand-in — Wokwi has no gas sensor part), 3× `wokwi-pushbutton`.

Pin map:

| Bin | Trig | Echo | Servo | Red LED | Green LED |
| --- | --- | --- | --- | --- | --- |
| Biodegradable | 13 | 35 | 33 | 16 | 17 |
| Recyclable | 14 | 36 | 32 | 18 | 19 |
| Non-recyclable | 26 | 39 | 25 | 21 | 22 |

Shared: gas potentiometer on **34**; fallback input on **27** (cycles class: BIO → REC → NON → NO_MATCH) and **23** (present item).

Two deliberate choices here. Echo lines use GPIO 35/36/39 and the gas sensor uses 34 — all input-only ADC1 pins, which is exactly what they suit. And **no ESP32 strapping pin (0, 2, 4, 5, 12, 15) and no UART pin (1, 3) is used**, so the same wiring would boot on real hardware without the flash-voltage and download-mode hazards that bite student projects, and the serial monitor stays available for debugging.

The fallback uses two buttons that cycle-and-confirm rather than three dedicated ones. Three would have forced a strapping pin into service for no functional gain.

Firmware must use `ESP32Servo.h`, not the AVR `Servo.h`.

### C4 — Written section (`docs/prototype-section.md`)

Drop-in text for outline item #9: what was simulated, how, screenshots, results against the p13 verification steps, and the limitations in §8 below.

### C5 — Troubleshooting scenarios

The document's troubleshooting guide (p13) is currently a static table. Three of its four entries become reproducible demonstrations:

| p13 entry | How the simulation reproduces it |
| --- | --- |
| Lid does not unlock on valid item | Dim the room or hold the item off-centre; confidence drops below 0.70, result becomes `NO_MATCH`, lid stays locked. Then fix the lighting and show it recover. |
| Erratic fill-level readings | Drag the HC-SR04 distance outside 2–400 cm; the median filter discards the reading and the last good value holds. |
| Gateway/cloud disconnection | Stop the classifier page or disconnect Wokwi's WiFi; firmware logs the drop, falls back to button input, and reconnects with backoff when restored. |
| Intermittent microcontroller resets | **Not reproducible.** Wokwi does not model power draw or inductive spikes from solenoid actuation. Stated as a limitation, not demonstrated. |

## 5. MQTT contract

Namespace is project-specific because HiveMQ's public broker is shared globally; a generic topic would collide with strangers mid-demonstration.

```
uc-swm-4d/station01/classify                        (classifier page → ESP32)
    {"class":"RECYCLABLE","confidence":0.94,"target":"REC",
     "source":"groq","item":"plastic bottle — clean PET, recyclable",
     "ts":1756377600}

  class      one of BIODEGRADABLE | RECYCLABLE | NON_RECYCLABLE | NO_MATCH
  target     BIO | REC | NON — the bin the item was presented to
  source     groq | gemini | teachable | mobilenet | manual — which classifier decided
  item       optional free text; only the cloud providers populate it

uc-swm-4d/station01/bin/{bio|rec|non}/telemetry      (ESP32 → broker)
    {"fill":42,"gas":180,"status":"OK"}

uc-swm-4d/station01/bin/{bio|rec|non}/event          (ESP32 → broker)
    {"event":"ACCEPT"}
    {"event":"REJECT","reason":"class_mismatch"}
    {"event":"REJECT","reason":"low_confidence"}
    {"event":"FULL","fill":91}
```

Transport differs by client and this is expected: browsers cannot open raw TCP sockets, so the page uses WebSocket on port 8000 while the ESP32 uses plain TCP on 1883. Both reach the same broker, and listener type does not restrict routing between clients.

## 6. Error handling

| Condition | Behaviour |
| --- | --- |
| Confidence below 0.70 | `NO_MATCH` → reject, red LED, `low_confidence` event |
| Class does not match target bin | Reject, red LED, `class_mismatch` event |
| Classification older than `CLASSIFY_TTL_MS` | Discarded; lid does not act on it |
| Ultrasonic reading outside 2–400 cm | Discarded by median filter; last good value retained |
| MQTT disconnected | Log, fall back to button input, reconnect with capped backoff |
| Bin full | Lid stays locked regardless of classification; `FULL` published |

## 7. Verification

Mirrors the three verification steps already written into the project document (p13), so the simulation validates the document's own acceptance criteria:

1. **Admission** — present a plastic bottle and a food scrap to each of the three target bins in turn. Confirm the servo actuates only on a match and the correct LED lights. 9 combinations, 3 accepts, 6 rejects.
2. **Fill level** — drag each HC-SR04 to empty, half, and full. Confirm reported percentage tracks the slider and the indicator flips at 85%.
3. **Telemetry** — subscribe in the HiveMQ web client and confirm payloads carrying bin ID, fill status, and gas reading arrive every 5 s.

Plus the three reproducible troubleshooting scenarios from §C5.

## 8. Limitations to state in the project document

1. **Classification runs off-device.** The camera and the model both sit on a laptop rather than on an ESP32-CAM. This matches the cloud-upload path in p9, but not the on-device Edge ML path in p11 — the production system would run TFLite Micro or Edge Impulse on the module itself.
2. **Cloud classification requires connectivity per item.** Every decision is a network round trip of roughly one to three seconds. A real bin on a congested cellular link, or with no signal, cannot behave this way; that is precisely why the documented design also specifies on-device inference. The Teachable Machine provider exists as the offline counter-example.
3. **The API key is held by the local server, not the browser**, so it is not exposed to the page. This is a real proxy, but it runs on the presenter's laptop and is loopback-only; a deployment would need an authenticated service rather than an open local endpoint.
4. **Free-tier rate limits** (5–15 requests/minute) bound how fast items can be presented.
5. Wokwi simulates the circuit, not physical dynamics — no lid mass, no acoustic reflection off irregular waste surfaces.
6. The public MQTT broker has no authentication and no TLS. Production requires credentials and port 8883.
7. Power behaviour is not simulated, so the p13 entry on solenoid-induced resets cannot be demonstrated.

## 9. Acceptance criteria

The work is done when:

- [ ] A trained 3-class model classifies held-up items live from the webcam
- [ ] All 9 present-item-to-bin combinations behave correctly (3 accept, 6 reject)
- [ ] Fill percentage tracks the HC-SR04 slider and flips the indicator at 85%
- [ ] Telemetry payloads are visible in an external MQTT client
- [ ] The button fallback drives the full flow with the classifier page closed
- [ ] All three reproducible troubleshooting scenarios demonstrate on demand
- [ ] `docs/prototype-section.md` is complete, including the limitations above
