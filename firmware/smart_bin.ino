/*
 * Smart Waste Management — station controller
 * IT-Elective 3, BSIT 4D, University of Cebu LM
 *
 * One ESP32 drives all three bin units of a station (biodegradable,
 * recyclable, non-recyclable). It implements the programming flowchart from
 * the project document:
 *
 *     start -> lock lids, lights on
 *           -> check fill level
 *              full?  -> red, publish FULL alert, lid stays shut, loop
 *              space? -> green "ready", wait for an item
 *                        item scanned -> right bin?
 *                            no  -> red, lid stays locked, loop
 *                            yes -> open lid, green, close, publish, loop
 *
 * Classification arrives over MQTT from the browser classifier node, which
 * runs Gemini (or a local Teachable Machine model) on a webcam. If the network
 * is unavailable, two pushbuttons drive the same logic so a demonstration can
 * continue offline.
 *
 * Wokwi: https://wokwi.com — paste this with diagram.json and libraries.txt.
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <ESP32Servo.h>
#include <ArduinoJson.h>   // v7+: uses JsonDocument, not StaticJsonDocument
#include <time.h>

/* ── configuration ──────────────────────────────────────────────────────── */

// Wokwi's virtual access point. Real credentials will not work in the
// simulator; the AP is always on channel 6, and naming it speeds up joining.
const char* WIFI_SSID    = "Wokwi-GUEST";
const char* WIFI_PASS    = "";
const int   WIFI_CHANNEL = 6;

// Plain TCP on 1883. The classifier page reaches the same broker over
// WebSocket on 8000; listener type does not restrict routing between clients.
const char* MQTT_HOST = "broker.hivemq.com";
const int   MQTT_PORT = 1883;

// Namespaced because the public broker is shared globally.
const char* TOPIC_ROOT   = "uc-swm-4d/station01";
const char* TOPIC_CLASSIFY = "uc-swm-4d/station01/classify";

const int  BIN_DEPTH_CM        = 40;    // empty lid-to-floor distance
const int  FULL_THRESHOLD_PCT  = 85;
const unsigned long TELEMETRY_INTERVAL_MS = 5000;
const unsigned long MEASURE_INTERVAL_MS   = 500;
const unsigned long CLASSIFY_TTL_MS       = 5000;
const float CONFIDENCE_MIN     = 0.70f;

// How much of the bin one admitted item is modelled to occupy. At 8% a bin
// reaches the 85% FULL threshold after roughly eleven items, which is enough
// for a demonstration without emptying it constantly.
const int  DEPOSIT_PCT_PER_ITEM = 8;
const unsigned long EMPTY_HOLD_MS = 1200;   // long-press BIN to empty a bin

const int LID_LOCKED_DEG = 0;
const int LID_OPEN_DEG   = 90;
const unsigned long LID_OPEN_MS = 2000;  // how long the lid stays open

const uint8_t PIN_GAS      = 39;  // MQ-135 stand-in (potentiometer in Wokwi)
const uint8_t PIN_BTN_BIN  = 27;  // cycles the active bin
const uint8_t PIN_BTN_ITEM = 23;  // presents an item, cycling its class

/* Pin choices, and why they are not arbitrary:
 *
 *  - Echo lines sit on GPIO 34/35/36 and the gas sensor on 39. All four are
 *    input-only, which is exactly what an echo line and an ADC input need.
 *  - The gas sensor must be on ADC1 (32-39). ADC2 is unusable while WiFi is
 *    active, which would have made a GPIO 25-27 reading silently return junk.
 *  - No strapping pin (0, 2, 4, 5, 12, 15) and no UART0 pin (1, 3) is used, so
 *    this wiring would also boot and stay debuggable on real hardware.
 *
 * Note that Wokwi's diagram.json labels differ from the GPIO numbers used
 * here: GPIO16 is "RX2", GPIO17 is "TX2", GPIO36 is "VP", GPIO39 is "VN".
 * analogRead() and pinMode() always take the numbers below, never the labels.
 */

/* ── bin model ──────────────────────────────────────────────────────────── */

/* Deliberately a plain aggregate: no default member initialisers, no
 * constructor. Under -std=gnu++11 - which older ESP32 Arduino cores still use -
 * a struct carrying default member initialisers stops being an aggregate and
 * the brace-initialised array below would fail to compile. The trailing
 * members are value-initialised to zero by the aggregate initialiser. */
struct Bin {
  const char* key;       // topic segment: bio | rec | non
  const char* category;  // BIODEGRADABLE | RECYCLABLE | NON_RECYCLABLE
  uint8_t trig, echo, servoPin, ledRed, ledGreen;

  Servo lock;
  int  fillPct;
  bool isFull;
  bool wasFull;
  int  samples[5];
  uint8_t sampleIdx;
  bool primed;
  int  depositPct;   // modelled volume of admitted items, added to the sensor
};

//                              trig echo servo ledR ledG
Bin bins[3] = {
  { "bio", "BIODEGRADABLE",  13,  34,  33,   16,  17 },
  { "rec", "RECYCLABLE",     14,  35,  32,   18,  19 },
  { "non", "NON_RECYCLABLE", 26,  36,  25,   21,  22 },
};
const uint8_t BIN_COUNT = 3;

WiFiClient net;
PubSubClient mqtt(net);

unsigned long lastTelemetry = 0;
unsigned long lastMeasure   = 0;
unsigned long lastReconnect = 0;
unsigned long reconnectWait = 1000;   // backoff, capped at 30s

uint8_t activeBin  = 1;  // button fallback: which bin is being approached
uint8_t nextItem   = 0;  // button fallback: class of the next simulated item
bool    lastBtnBin = HIGH, lastBtnItem = HIGH;
unsigned long btnBinDownAt = 0;
bool    binHoldHandled = false;

/* ── helpers ────────────────────────────────────────────────────────────── */

int binIndexByShort(const char* s) {
  if (!strcasecmp(s, "BIO")) return 0;
  if (!strcasecmp(s, "REC")) return 1;
  if (!strcasecmp(s, "NON")) return 2;
  return -1;
}

/** Median of the last five readings. Rejects the dropouts and echo artefacts
 *  that the troubleshooting guide describes as "erratic fill-level readings". */
int medianOf(int* a) {
  int c[5];
  memcpy(c, a, sizeof(c));
  for (int i = 1; i < 5; i++) {
    int v = c[i], j = i - 1;
    while (j >= 0 && c[j] > v) { c[j + 1] = c[j]; j--; }
    c[j + 1] = v;
  }
  return c[2];
}

int readDistanceCm(Bin& b) {
  digitalWrite(b.trig, LOW);
  delayMicroseconds(2);
  digitalWrite(b.trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(b.trig, LOW);
  long us = pulseIn(b.echo, HIGH, 25000UL);   // ~4.3 m ceiling
  if (us == 0) return -1;                     // no echo
  int cm = (int)(us * 0.0343 / 2.0);
  if (cm < 2 || cm > 400) return -1;          // out of sensor range
  return cm;
}

/* Fill level has two sources that add together.
 *
 * The ultrasonic sensor gives the physical level, which in Wokwi is whatever
 * the HC-SR04 distance slider is set to. Firmware cannot move that slider - no
 * code can drive a simulated sensor - so on its own the bin would never get any
 * fuller no matter how many items it accepted.
 *
 * So each admitted item also adds DEPOSIT_PCT_PER_ITEM to a modelled deposit,
 * standing in for the volume the item occupies. Dragging the slider still
 * works and still registers; the deposit rides on top of it. Long-press the
 * BIN button to empty a bin and clear its deposit.
 */
void measure(Bin& b) {
  int cm = readDistanceCm(b);
  if (cm < 0) return;                          // discard, keep last good value
  b.samples[b.sampleIdx] = cm;
  b.sampleIdx = (b.sampleIdx + 1) % 5;
  if (!b.primed) {
    for (int i = 0; i < 5; i++) b.samples[i] = cm;
    b.primed = true;
  }
  int d = medianOf(b.samples);
  int sensorPct = (int)round((float)(BIN_DEPTH_CM - d) * 100.0f / (float)BIN_DEPTH_CM);
  sensorPct = constrain(sensorPct, 0, 100);
  b.fillPct = constrain(sensorPct + b.depositPct, 0, 100);
  b.isFull  = b.fillPct >= FULL_THRESHOLD_PCT;
}

void emptyBin(Bin& b) {
  b.depositPct = 0;
  measure(b);
  b.wasFull = b.isFull;
  Serial.printf("[%s] emptied - deposit cleared, now %d%%\n", b.key, b.fillPct);
  publishEvent(b, "EMPTIED", nullptr);
  publishTelemetry(b);
  showIdle(b);
}

void showIdle(Bin& b) {
  digitalWrite(b.ledRed,   b.isFull ? HIGH : LOW);
  digitalWrite(b.ledGreen, b.isFull ? LOW  : HIGH);
}

void flash(Bin& b, bool green, unsigned long ms) {
  digitalWrite(b.ledRed,   green ? LOW  : HIGH);
  digitalWrite(b.ledGreen, green ? HIGH : LOW);
  delay(ms);
  showIdle(b);
}

/* ── publishing ─────────────────────────────────────────────────────────── */

void publishJson(const char* leaf, const char* binKey, JsonDocument& doc) {
  char topic[96];
  snprintf(topic, sizeof(topic), "%s/bin/%s/%s", TOPIC_ROOT, binKey, leaf);
  char body[256];
  size_t n = serializeJson(doc, body, sizeof(body));
  if (mqtt.connected()) mqtt.publish(topic, (const uint8_t*)body, n, false);
  Serial.printf("  -> %s %s\n", topic, body);
}

void publishTelemetry(Bin& b) {
  JsonDocument doc;
  doc["fill"]   = b.fillPct;
  doc["gas"]    = analogRead(PIN_GAS);
  doc["status"] = b.isFull ? "FULL" : "OK";
  publishJson("telemetry", b.key, doc);
}

void publishEvent(Bin& b, const char* event, const char* reason) {
  JsonDocument doc;
  doc["event"] = event;
  if (reason) doc["reason"] = reason;
  doc["fill"] = b.fillPct;
  publishJson("event", b.key, doc);
}

/* ── admission control ──────────────────────────────────────────────────── */

void admit(Bin& b) {
  Serial.printf("[%s] ACCEPT - unlocking lid\n", b.key);
  digitalWrite(b.ledGreen, HIGH);
  digitalWrite(b.ledRed, LOW);
  b.lock.write(LID_OPEN_DEG);
  delay(LID_OPEN_MS);
  b.lock.write(LID_LOCKED_DEG);
  // the item is now inside, so the bin is that much fuller
  b.depositPct = constrain(b.depositPct + DEPOSIT_PCT_PER_ITEM, 0, 100);
  measure(b);
  Serial.printf("[%s] now %d%% full
", b.key, b.fillPct);
  publishEvent(b, "ACCEPT", nullptr);
  publishTelemetry(b);
  showIdle(b);
}

void reject(Bin& b, const char* reason) {
  Serial.printf("[%s] REJECT (%s) - lid stays locked\n", b.key, reason);
  publishEvent(b, "REJECT", reason);
  flash(b, false, 1500);
}

/** The decision from the flowchart, applied to one presented item. */
void present(int binIdx, const char* itemClass, float confidence) {
  if (binIdx < 0 || binIdx >= BIN_COUNT) return;
  Bin& b = bins[binIdx];

  Serial.printf("[%s] item=%s conf=%.2f\n", b.key, itemClass, confidence);

  if (b.isFull)                             { reject(b, "bin_full");        return; }
  if (!strcmp(itemClass, "NO_MATCH"))       { reject(b, "no_item");         return; }
  if (confidence < CONFIDENCE_MIN)          { reject(b, "low_confidence");  return; }
  if (strcmp(itemClass, b.category) != 0)   { reject(b, "class_mismatch");  return; }
  admit(b);
}

/* ── MQTT ───────────────────────────────────────────────────────────────── */

void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.println("!! classification payload was not valid JSON");
    return;
  }

  const char* cls    = doc["class"]  | "NO_MATCH";
  const char* target = doc["target"] | "";
  float conf         = doc["confidence"] | 0.0f;
  unsigned long ts   = doc["ts"] | 0UL;
  const char* item   = doc["item"] | "";

  if (strlen(item)) Serial.printf("   seen: %s\n", item);

  // A stale ACCEPT must never unlock a bin minutes after the fact. The page
  // stamps ts in epoch seconds; anything older than the TTL is dropped.
  //
  // The subtraction is kept signed on purpose. If the laptop's clock runs a
  // few seconds ahead of NTP the age is negative, and an unsigned subtraction
  // would wrap to something enormous and reject every valid message.
  time_t nowSec = time(nullptr);
  if (ts > 0 && nowSec > 1700000000L) {
    long ageSec = (long)(nowSec - (time_t)ts);
    if (ageSec > (long)(CLASSIFY_TTL_MS / 1000UL)) {
      Serial.printf("!! discarding stale classification (%lds old)\n", ageSec);
      return;
    }
  }

  int idx = binIndexByShort(target);
  if (idx < 0) {
    Serial.printf("!! unknown target bin \"%s\"\n", target);
    return;
  }
  present(idx, cls, conf);
}

void ensureMqtt() {
  if (mqtt.connected()) return;
  if (millis() - lastReconnect < reconnectWait) return;
  lastReconnect = millis();

  char id[32];
  snprintf(id, sizeof(id), "swm-station01-%06X", (uint32_t)(ESP.getEfuseMac() & 0xFFFFFF));
  Serial.printf("MQTT connecting as %s ... ", id);

  if (mqtt.connect(id)) {
    Serial.println("connected");
    mqtt.subscribe(TOPIC_CLASSIFY);
    Serial.printf("subscribed to %s\n", TOPIC_CLASSIFY);
    reconnectWait = 1000;
  } else {
    reconnectWait = min(reconnectWait * 2, 30000UL);
    Serial.printf("failed rc=%d, retry in %lums\n", mqtt.state(), reconnectWait);
  }
}

/* ── button fallback ────────────────────────────────────────────────────── */

void pollButtons() {
  bool bBin  = digitalRead(PIN_BTN_BIN);
  bool bItem = digitalRead(PIN_BTN_ITEM);

  if (lastBtnBin == HIGH && bBin == LOW) {
    activeBin = (activeBin + 1) % BIN_COUNT;
    Serial.printf("\n>> active bin: %s (%s)\n", bins[activeBin].key, bins[activeBin].category);
    Serial.printf(">> next item would be: %s\n", bins[nextItem].category);
    flash(bins[activeBin], true, 250);
    delay(120);  // debounce
  }

  if (lastBtnItem == HIGH && bItem == LOW) {
    const char* cls = bins[nextItem].category;
    Serial.printf("\n>> presenting %s to the %s bin\n", cls, bins[activeBin].key);
    present(activeBin, cls, 1.0f);
    nextItem = (nextItem + 1) % BIN_COUNT;
    Serial.printf(">> next item will be: %s\n", bins[nextItem].category);
    delay(120);
  }

  lastBtnBin  = bBin;
  lastBtnItem = bItem;
}

/* ── setup / loop ───────────────────────────────────────────────────────── */

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n=== Smart Waste Management - station 01 ===");

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);

  pinMode(PIN_BTN_BIN,  INPUT_PULLUP);
  pinMode(PIN_BTN_ITEM, INPUT_PULLUP);

  // Flowchart step one: lock every lid and turn the indicators on.
  for (uint8_t i = 0; i < BIN_COUNT; i++) {
    Bin& b = bins[i];
    pinMode(b.trig, OUTPUT);
    pinMode(b.echo, INPUT);
    pinMode(b.ledRed, OUTPUT);
    pinMode(b.ledGreen, OUTPUT);
    b.lock.setPeriodHertz(50);
    b.lock.attach(b.servoPin, 500, 2400);
    b.lock.write(LID_LOCKED_DEG);
    digitalWrite(b.ledRed, HIGH);
    digitalWrite(b.ledGreen, HIGH);
  }
  delay(600);
  Serial.println("All lids locked. Indicators tested.");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS, WIFI_CHANNEL);
  Serial.print("WiFi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    Serial.print('.');
    delay(250);
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf(" connected, ip=%s\n", WiFi.localIP().toString().c_str());
    configTime(0, 0, "pool.ntp.org");   // needed for the staleness check
  } else {
    Serial.println(" FAILED - running offline, use the buttons");
  }

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(512);   // default 256 is too small once "item" is present

  for (uint8_t i = 0; i < BIN_COUNT; i++) { measure(bins[i]); showIdle(bins[i]); }

  Serial.println("\nButtons:  GPIO27 = change bin   GPIO23 = present an item");
  Serial.printf("Active bin: %s. Next item: %s\n\n",
                bins[activeBin].key, bins[nextItem].category);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) { ensureMqtt(); mqtt.loop(); }
  pollButtons();

  unsigned long now = millis();

  if (now - lastMeasure >= MEASURE_INTERVAL_MS) {
    lastMeasure = now;
    for (uint8_t i = 0; i < BIN_COUNT; i++) {
      Bin& b = bins[i];
      measure(b);
      showIdle(b);
      if (b.isFull && !b.wasFull) {           // publish the alert on transition
        Serial.printf("[%s] FULL at %d%%\n", b.key, b.fillPct);
        publishEvent(b, "FULL", nullptr);
      }
      b.wasFull = b.isFull;
    }
  }

  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) {
    lastTelemetry = now;
    for (uint8_t i = 0; i < BIN_COUNT; i++) publishTelemetry(bins[i]);
  }
}
