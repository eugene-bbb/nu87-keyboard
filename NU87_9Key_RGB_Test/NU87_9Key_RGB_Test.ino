/*
  NU87-TinyDK 3x3 키 매트릭스 + 온보드 RGB LED

  매트릭스:
                  C0 PB22       C1 PA27       C2 PB3
    R0 PB1        SW1           SW2           SW3
    R1 PB2        SW4           SW5           SW6
    R2 PB23       SW7           SW8           SW9

  중요:
  이 보드에서는 선택하지 않은 행도 INPUT_PULLUP으로 유지해야 합니다.
  INPUT_PULLNONE을 사용하면 SW7이 SW1 + SW4 + SW7로 잘못 인식될 수 있습니다.
*/

#include <Arduino.h>

// 온보드 RGB LED: active HIGH
constexpr uint8_t PIN_LED_G = PA12;
constexpr uint8_t PIN_LED_R = PA13;
constexpr uint8_t PIN_LED_B = PA14;

// 3x3 키 매트릭스
constexpr uint8_t ROWS[3] = {PB1, PB2, PB23};
const uint8_t COLS[3] = {PB22, PA27, PB3};

constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint32_t SCAN_PERIOD_MS = 2;
constexpr uint32_t DEBOUNCE_MS = 20;

// LED 최대 밝기 제한
constexpr uint8_t MAX_LED_LEVEL = 96;

struct Colour {
  uint8_t r;
  uint8_t g;
  uint8_t b;
  const char *hex;
};

// SW1~SW9 색상
constexpr Colour COLOURS[9] = {
  {255,   0,   0, "#FF0000"}, // SW1 Red
  {255,  64,   0, "#FF4000"}, // SW2 Orange
  {255, 255,   0, "#FFFF00"}, // SW3 Yellow
  {  0, 255,   0, "#00FF00"}, // SW4 Green
  {  0,   0, 255, "#0000FF"}, // SW5 Blue
  { 20,   0,  74, "#14004A"}, // SW6 Indigo
  {  0, 255, 255, "#00FFFF"}, // SW7 Cyan
  {255,   0,  80, "#FF0050"}, // SW8 Hot Pink
  {255, 255, 255, "#FFFFFF"}  // SW9 White
};

uint8_t pwmR = 0;
uint8_t pwmG = 0;
uint8_t pwmB = 0;

uint16_t candidateMask = 0;
uint16_t stableMask = 0;

uint32_t candidateSince = 0;
uint32_t lastScan = 0;

int8_t selectedKey = -1;

uint8_t lastIdleFault = 0;
bool lastGhost = false;

uint8_t limited(uint8_t value)
{
  return (uint8_t)(
      ((uint16_t)value * MAX_LED_LEVEL + 127U) / 255U
  );
}

/*
  모든 행을 비활성 상태로 돌립니다.

  NU87-TinyDK에서는 INPUT_PULLNONE이 아니라 INPUT_PULLUP을 사용해야
  SW7이 R2에서만 정상적으로 인식됩니다.
*/
void releaseRows()
{
  for (uint8_t r = 0; r < 3; ++r) {
    pinMode(ROWS[r], INPUT_PULLUP);
  }
}

uint8_t readLowColumns()
{
  uint8_t lowColumns = 0;

  for (uint8_t c = 0; c < 3; ++c) {
    if (digitalRead(COLS[c]) == LOW) {
      lowColumns |= (1U << c);
    }
  }

  return lowColumns;
}

uint16_t scanMatrix()
{
  uint16_t mask = 0;

  for (uint8_t r = 0; r < 3; ++r) {
    // 먼저 모든 행을 풀업 입력으로 비활성화
    releaseRows();

    // 출력 모드로 전환하기 전에 LOW를 미리 기록
    digitalWrite(ROWS[r], LOW);
    pinMode(ROWS[r], OUTPUT);

    // GPIO와 매트릭스 신호가 안정될 시간
    delayMicroseconds(50);

    const uint8_t lowColumns = readLowColumns();

    for (uint8_t c = 0; c < 3; ++c) {
      if (lowColumns & (1U << c)) {
        const uint8_t key = r * 3 + c;
        mask |= (1U << key);
      }
    }

    // 선택했던 행도 다시 풀업 입력으로 복귀
    pinMode(ROWS[r], INPUT_PULLUP);
  }

  return mask;
}

/*
  다이오드가 없는 매트릭스에서 두 행이 두 개 이상의 열을 공유하면
  사각형이 만들어져 고스트 입력이 발생할 수 있습니다.
*/
bool containsRectangle(uint16_t mask)
{
  uint8_t rowBits[3];

  for (uint8_t r = 0; r < 3; ++r) {
    rowBits[r] = (mask >> (r * 3)) & 0x07;
  }

  for (uint8_t first = 0; first < 2; ++first) {
    for (uint8_t second = first + 1; second < 3; ++second) {
      const uint8_t shared = rowBits[first] & rowBits[second];

      // 공통 열이 두 개 이상인지 확인
      if (shared && (shared & (shared - 1U))) {
        return true;
      }
    }
  }

  return false;
}

void setKey(int8_t key)
{
  selectedKey = key;

  if (key < 0) {
    pwmR = 0;
    pwmG = 0;
    pwmB = 0;

    Serial.println("NONE LED_OFF");
    return;
  }

  pwmR = limited(COLOURS[key].r);
  pwmG = limited(COLOURS[key].g);
  pwmB = limited(COLOURS[key].b);

  Serial.print("SW");
  Serial.print(key + 1);
  Serial.print(' ');
  Serial.println(COLOURS[key].hex);
}

/*
  약 195Hz 소프트웨어 PWM:
  20us × 256단계 = 약 5.12ms
*/
void serviceRgb()
{
  const uint8_t phase =
      (uint8_t)((micros() / 20U) & 0xFFU);

  digitalWrite(
      PIN_LED_R,
      phase < pwmR ? HIGH : LOW
  );

  digitalWrite(
      PIN_LED_G,
      phase < pwmG ? HIGH : LOW
  );

  digitalWrite(
      PIN_LED_B,
      phase < pwmB ? HIGH : LOW
  );
}

void reportIdleFault(uint8_t lowColumns)
{
  if (lowColumns == lastIdleFault) {
    return;
  }

  lastIdleFault = lowColumns;

  if (lowColumns == 0) {
    Serial.println("WIRING_CLEAR");
    return;
  }

  Serial.print("WIRING_FAULT IDLE_COL_LOW=0b");

  for (int8_t c = 2; c >= 0; --c) {
    Serial.print(
        lowColumns & (1U << c) ? '1' : '0'
    );
  }

  Serial.println(" (remove GND/short from column)");
}

void setup()
{
  Serial.begin(SERIAL_BAUD);

  pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT);
  pinMode(PIN_LED_B, OUTPUT);

  // RGB LED는 active HIGH이므로 LOW가 OFF
  digitalWrite(PIN_LED_R, LOW);
  digitalWrite(PIN_LED_G, LOW);
  digitalWrite(PIN_LED_B, LOW);

  // 모든 행은 비활성 상태에서도 풀업 유지
  releaseRows();

  // 열 입력도 풀업
  for (uint8_t c = 0; c < 3; ++c) {
    pinMode(COLS[c], INPUT_PULLUP);
  }

  delay(100);

  candidateSince = millis();

  Serial.println("NU87_9KEY_RGB_READY");
  Serial.println("ROWS=PB1,PB2,PB23");
  Serial.println("COLS=PB22,PA27,PB3");
}

void loop()
{
  // 스캔 대기 중에도 RGB PWM을 계속 처리
  serviceRgb();

  const uint32_t now = millis();

  if ((uint32_t)(now - lastScan) < SCAN_PERIOD_MS) {
    return;
  }

  lastScan = now;

  /*
    스캔 전 모든 행을 비활성화하고, 열이 외부에서 LOW로 고정되어
    있는지 확인합니다.
  */
  releaseRows();
  delayMicroseconds(100);

  const uint8_t idleFault = readLowColumns();
  reportIdleFault(idleFault);

  uint16_t sample = 0;

  if (idleFault == 0) {
    sample = scanMatrix();
  }

  // 고스트 입력 확인
  const bool ghost = containsRectangle(sample);

  if (ghost != lastGhost) {
    lastGhost = ghost;

    if (ghost) {
      Serial.print("GHOST_BLOCK MASK=0x");
      Serial.println(sample, HEX);
    } else {
      Serial.println("GHOST_CLEAR");
    }
  }

  if (ghost) {
    sample = 0;
  }

  // 디바운싱 후보가 바뀌면 타이머 재시작
  if (sample != candidateMask) {
    candidateMask = sample;
    candidateSince = now;
    return;
  }

  // 같은 상태가 DEBOUNCE_MS 이상 유지됐을 때만 확정
  if (stableMask != candidateMask &&
      (uint32_t)(now - candidateSince) >= DEBOUNCE_MS) {
    stableMask = candidateMask;

    int8_t nextKey = -1;

    // 여러 키가 눌리면 번호가 가장 작은 키의 색상을 출력
    for (uint8_t key = 0; key < 9; ++key) {
      if (stableMask & (1U << key)) {
        nextKey = key;
        break;
      }
    }

    if (nextKey != selectedKey) {
      setKey(nextKey);
    }
  }
}