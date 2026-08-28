# Smart Waste Management — Prototype / Simulation

Outline item #9 for the IT-Elective 3 project (BSIT 4D, University of Cebu LM).

Two halves joined by real MQTT:

```
  laptop webcam                          Wokwi (real ESP32 firmware)
  ┌──────────────────┐                   ┌────────────────────────┐
  │ classifier page  │   MQTT over ws    │ 3 × HC-SR04  fill      │
  │ Gemini / TM      │ ────────────────▶ │ 3 × servo    lid lock  │
  │ picks the class  │  broker.hivemq    │ 6 × LED      status    │
  └──────────────────┘        .com       │ 1 × pot      gas       │
                                         └────────────────────────┘
```

## 1. Run the classifier

```
classifier\serve.bat
```

Opens `http://localhost:8000`. **Do not open `index.html` directly** — Chrome
blocks camera access on `file://`.

Pick a classifier in the settings bar at the bottom:

| Provider | Needs | Notes |
| --- | --- | --- |
| **Gemini** (default) | free API key from [aistudio.google.com](https://aistudio.google.com) | Best accuracy. On-demand only — free tier is 5–15 requests/min. |
| **Teachable Machine** | an exported model in `classifier\model\` | Runs offline at ~5 fps. Use this if the venue has no wifi. |
| **MobileNet heuristic** | internet on first load | Placeholder only. Labelled untrained in the UI. |

The API key is stored in your browser's `localStorage`. It is never written to
a file here and never committed.

## 2. Run the bin controller

Open [wokwi.com](https://wokwi.com) → new ESP32 project, then paste in:

- `firmware/smart_bin.ino` → the sketch tab
- `firmware/diagram.json` → the diagram tab
- `firmware/libraries.txt` → the library manager

Press play. The serial monitor shows the connection and every decision.

## 3. Demonstrate

**With the camera:** pick a target bin on the page, hold an item to the webcam,
press *Present item*. A match opens that bin's lid and lights its green LED; a
mismatch keeps it locked and lights red. Drag any HC-SR04's distance slider to
change fill level — below 6 cm the bin reports FULL and refuses everything.

**Without the network:** press the Wokwi buttons instead.

- **GPIO27 (blue)** — change which bin is being approached
- **GPIO23 (yellow)** — present an item, cycling BIO → REC → NON each press

Three presses on any bin therefore show reject, accept, reject in order.

## 4. Watch the telemetry

Open the [HiveMQ web client](https://www.hivemq.com/demos/websocket-client/)
and subscribe to:

```
uc-swm-4d/station01/#
```

You will see `telemetry` every 5 s per bin, plus `event` messages for
ACCEPT / REJECT / FULL.

## Layout

```
classifier/    webcam classifier page (Gemini / Teachable Machine / MobileNet)
  vendor/      TF.js, Teachable Machine, MQTT.js, MobileNet — vendored for offline use
  model/       drop an exported Teachable Machine model here
firmware/      ESP32 station controller for Wokwi
docs/          design spec
```

## Known limitations

Stated in full in `docs/superpowers/specs/2026-08-28-smart-waste-simulation-design.md` §8.
The short version: classification runs off-device rather than on an ESP32-CAM,
the API key is visible in the browser, the public broker has no auth or TLS, and
Wokwi does not model power draw — so the "intermittent resets from solenoid
spikes" entry in the troubleshooting guide cannot be reproduced here.
