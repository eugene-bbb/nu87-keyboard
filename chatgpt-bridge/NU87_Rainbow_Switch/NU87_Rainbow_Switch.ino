/*
  NU87-TinyDK: hold a switch on PB2 to run the onboard RGB rainbow.

  Onboard RGB LED (active HIGH):
    Green = PA12, Red = PA13, Blue = PA14
  External 2-pin switch:
    PB2 --- switch --- GND  (INPUT_PULLUP, pressed = LOW)
  KY-040 rotary encoder:
    CLK = PB20, DT = PB21, SW = PB22 (all INPUT_PULLUP)

  The AmebaD AMB25/AMB26 Arduino variant supports hardware PWM on PA12
  and PA13, but not on PA14.  This sketch therefore uses the same
  non-blocking software PWM for all three channels.
*/

#include <Arduino.h>

constexpr uint8_t PIN_LED_G = PA12;
constexpr uint8_t PIN_LED_R = PA13;
constexpr uint8_t PIN_LED_B = PA14;
constexpr uint8_t PIN_SWITCH = PB2;
constexpr uint8_t PIN_ENCODER_CLK = PB20;
constexpr uint8_t PIN_ENCODER_DT = PB21;
constexpr uint8_t PIN_ENCODER_SW = PB22;

constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint32_t DEBOUNCE_MS = 20;
constexpr uint32_t ENCODER_BUTTON_DEBOUNCE_MS = 25;
constexpr uint32_t RAINBOW_PERIOD_MS = 5000;

// 20 us x 256 steps = 5.12 ms per PWM cycle (about 195 Hz).
constexpr uint32_t PWM_TICK_US = 20;

uint8_t redLevel = 0;
uint8_t greenLevel = 0;
uint8_t blueLevel = 0;
uint8_t pwmPhase = 255;
uint32_t lastPwmTickUs = 0;
bool ledMayBeOn = false;

bool lastRawSwitch = HIGH;
bool stableSwitch = HIGH;
uint32_t rawChangedAtMs = 0;

bool lastRawEncoderButton = HIGH;
bool stableEncoderButton = HIGH;
uint32_t encoderButtonChangedAtMs = 0;

uint8_t encoderState = 0;
int8_t encoderAccumulator = 0;

bool rainbowRunning = false;
uint32_t rainbowStartedAtMs = 0;

char serialCommand[16] = {};
uint8_t serialCommandLength = 0;

// Valid quadrature transitions contribute +/-1. Four transitions are one
// KY-040 detent. Invalid/bounce transitions contribute zero.
constexpr int8_t QUADRATURE_TABLE[16] = {
   0, -1,  1,  0,
   1,  0,  0, -1,
  -1,  0,  0,  1,
   0,  1, -1,  0
};

void serviceEncoderRotation()
{
  const uint8_t current =
      (digitalRead(PIN_ENCODER_CLK) << 1) | digitalRead(PIN_ENCODER_DT);
  if (current == encoderState) {
    return;
  }

  encoderAccumulator += QUADRATURE_TABLE[(encoderState << 2) | current];
  encoderState = current;

  // With CLK on PB20 and DT on PB21, the usual KY-040 wiring produces -4
  // for clockwise. Swap the two event names if a particular module is wired
  // with the opposite phase convention.
  if (encoderAccumulator <= -4) {
    Serial.println("ENC_CW");
    encoderAccumulator = 0;
  } else if (encoderAccumulator >= 4) {
    Serial.println("ENC_CCW");
    encoderAccumulator = 0;
  }
}

void serviceEncoderButton(uint32_t nowMs)
{
  const bool raw = digitalRead(PIN_ENCODER_SW);
  if (raw != lastRawEncoderButton) {
    lastRawEncoderButton = raw;
    encoderButtonChangedAtMs = nowMs;
  }

  if ((raw != stableEncoderButton) &&
      ((uint32_t)(nowMs - encoderButtonChangedAtMs) >=
       ENCODER_BUTTON_DEBOUNCE_MS)) {
    stableEncoderButton = raw;
    if (stableEncoderButton == LOW) {
      Serial.println("ENC_CLICK");
    }
  }
}

void serviceSerialCommands()
{
  while (Serial.available() > 0) {
    const char value = (char)Serial.read();
    if (value == '\r') {
      continue;
    }
    if (value == '\n') {
      serialCommand[serialCommandLength] = '\0';
      if (strcmp(serialCommand, "HOST_READY") == 0) {
        Serial.print("READY PB2=");
        Serial.print(digitalRead(PIN_SWITCH));
        Serial.print(" CLK=");
        Serial.print(digitalRead(PIN_ENCODER_CLK));
        Serial.print(" DT=");
        Serial.print(digitalRead(PIN_ENCODER_DT));
        Serial.print(" SW=");
        Serial.println(digitalRead(PIN_ENCODER_SW));
      }
      serialCommandLength = 0;
      continue;
    }
    if (serialCommandLength < sizeof(serialCommand) - 1) {
      serialCommand[serialCommandLength++] = value;
    } else {
      serialCommandLength = 0;
    }
  }
}

void forceLedOff()
{
  redLevel = 0;
  greenLevel = 0;
  blueLevel = 0;

  if (ledMayBeOn) {
    digitalWrite(PIN_LED_R, LOW);
    digitalWrite(PIN_LED_G, LOW);
    digitalWrite(PIN_LED_B, LOW);
    ledMayBeOn = false;
  }
}

void serviceSoftwarePwm()
{
  const uint32_t nowUs = micros();
  if ((uint32_t)(nowUs - lastPwmTickUs) < PWM_TICK_US) {
    return;
  }

  // Advance one PWM step without blocking. Resetting to now avoids a long
  // catch-up loop if the RTOS briefly preempts the Arduino loop task.
  lastPwmTickUs = nowUs;
  ++pwmPhase;

  if (pwmPhase == 0) {
    digitalWrite(PIN_LED_R, redLevel   ? HIGH : LOW);
    digitalWrite(PIN_LED_G, greenLevel ? HIGH : LOW);
    digitalWrite(PIN_LED_B, blueLevel  ? HIGH : LOW);
    ledMayBeOn = (redLevel | greenLevel | blueLevel) != 0;
    return;
  }

  if (pwmPhase == redLevel) {
    digitalWrite(PIN_LED_R, LOW);
  }
  if (pwmPhase == greenLevel) {
    digitalWrite(PIN_LED_G, LOW);
  }
  if (pwmPhase == blueLevel) {
    digitalWrite(PIN_LED_B, LOW);
  }
}

// hue: 0..1535. Six continuous 256-step sectors:
// red -> yellow -> green -> cyan -> blue -> magenta -> red.
// Orange and purple naturally occur inside those transitions.
void hueToRgb(uint16_t hue, uint8_t &r, uint8_t &g, uint8_t &b)
{
  const uint8_t sector = hue >> 8;
  const uint8_t offset = hue & 0xFF;

  switch (sector) {
    case 0: r = 255;          g = offset;       b = 0;            break;
    case 1: r = 255 - offset; g = 255;          b = 0;            break;
    case 2: r = 0;            g = 255;          b = offset;       break;
    case 3: r = 0;            g = 255 - offset; b = 255;          break;
    case 4: r = offset;       g = 0;            b = 255;          break;
    default:r = 255;          g = 0;            b = 255 - offset; break;
  }
}

void startRainbow(uint32_t nowMs)
{
  rainbowRunning = true;
  rainbowStartedAtMs = nowMs;

  // Start at pure red and make the next PWM service begin a fresh frame.
  redLevel = 255;
  greenLevel = 0;
  blueLevel = 0;
  pwmPhase = 255;
  lastPwmTickUs = micros() - PWM_TICK_US;
}

void stopRainbow()
{
  rainbowRunning = false;
  forceLedOff();
}

void setup()
{
  // NU87-TinyDK's LOG UART is connected to the onboard CP2102 USB-UART.
  Serial.begin(SERIAL_BAUD);

  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);

  // The RGB LED is active HIGH, so LOW means completely off.
  digitalWrite(PIN_LED_R, LOW);
  digitalWrite(PIN_LED_G, LOW);
  digitalWrite(PIN_LED_B, LOW);

  pinMode(PIN_SWITCH, INPUT_PULLUP);
  pinMode(PIN_ENCODER_CLK, INPUT_PULLUP);
  pinMode(PIN_ENCODER_DT, INPUT_PULLUP);
  pinMode(PIN_ENCODER_SW, INPUT_PULLUP);

  lastRawSwitch = digitalRead(PIN_SWITCH);
  stableSwitch = lastRawSwitch;
  rawChangedAtMs = millis();

  // If powered while held, begin after one debounce interval.
  if (stableSwitch == LOW) {
    stableSwitch = HIGH;
  }

  encoderState =
      (digitalRead(PIN_ENCODER_CLK) << 1) | digitalRead(PIN_ENCODER_DT);
  lastRawEncoderButton = digitalRead(PIN_ENCODER_SW);
  stableEncoderButton = lastRawEncoderButton;
  encoderButtonChangedAtMs = millis();
  if (stableEncoderButton == LOW) {
    stableEncoderButton = HIGH;
  }
}

void loop()
{
  const uint32_t nowMs = millis();
  const bool rawSwitch = digitalRead(PIN_SWITCH);

  serviceSerialCommands();
  serviceEncoderRotation();
  serviceEncoderButton(nowMs);

  // Standard time-based debounce.
  if (rawSwitch != lastRawSwitch) {
    lastRawSwitch = rawSwitch;
    rawChangedAtMs = nowMs;
  }

  if ((rawSwitch != stableSwitch) &&
      ((uint32_t)(nowMs - rawChangedAtMs) >= DEBOUNCE_MS)) {
    stableSwitch = rawSwitch;

    if (stableSwitch == LOW) {
      startRainbow(nowMs);
      // Emit exactly once on the debounced released -> pressed edge.
      Serial.println("BUTTON");
    } else {
      stopRainbow();
    }
  }

  // A raw release turns every channel off immediately. The debounced release
  // below is still what resets the animation state for the next press.
  if (!rainbowRunning || rawSwitch == HIGH) {
    forceLedOff();
    return;
  }

  const uint32_t elapsedMs = nowMs - rainbowStartedAtMs;
  const uint32_t cycleMs = elapsedMs % RAINBOW_PERIOD_MS;
  const uint16_t hue = (uint16_t)((cycleMs * 1536UL) / RAINBOW_PERIOD_MS);

  hueToRgb(hue, redLevel, greenLevel, blueLevel);
  serviceSoftwarePwm();
}
