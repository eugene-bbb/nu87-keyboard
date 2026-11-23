/*
  NU87 TinyDK PA7 runtime GPIO test, AMB25 core 3.1.9.

  This intentionally never calls Serial.begin(): the AMB25 core maps LOG_TX to
  PA7. USB-C remains powered/connected for upload, but no runtime LOG UART is
  configured. A debounced active-LOW press toggles the on-board RGB LED.
  Upload this first; verify boot, one toggle per press, reset, and re-upload.
*/
#include <Arduino.h>

constexpr uint8_t PIN_PA7_BUTTON = PA7;
constexpr uint8_t PIN_LED_G = PA12, PIN_LED_R = PA13, PIN_LED_B = PA14;
constexpr uint32_t DEBOUNCE_MS = 25;

bool raw = HIGH, stable = HIGH, led = false;
uint32_t changedAt = 0;

void setLed(bool on) {
  digitalWrite(PIN_LED_R, on ? HIGH : LOW);
  digitalWrite(PIN_LED_G, LOW);
  digitalWrite(PIN_LED_B, LOW);
}

void setup() {
  pinMode(PIN_LED_R, OUTPUT); pinMode(PIN_LED_G, OUTPUT); pinMode(PIN_LED_B, OUTPUT);
  setLed(false);
  // Runtime GPIO mux selection happens only after reset/boot ROM has finished.
  pinMode(PIN_PA7_BUTTON, INPUT_PULLUP);
  raw = stable = digitalRead(PIN_PA7_BUTTON);
  changedAt = millis();
}

void loop() {
  const uint32_t now = millis();
  const bool sample = digitalRead(PIN_PA7_BUTTON);
  if (sample != raw) { raw = sample; changedAt = now; }
  if (sample != stable && now - changedAt >= DEBOUNCE_MS) {
    stable = sample;
    if (stable == LOW) { led = !led; setLed(led); }
  }
}
