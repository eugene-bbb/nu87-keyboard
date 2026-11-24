# NU87 Home + Key Mapping integration test

Target: **AMB25 / RTL8720DF, AmebaD 3.1.9**, ST7796S 480×320 in landscape.
The panel remains on the verified GPIO-register software SPI path:
PB18 MOSI, PB20 SCK, D4/physical PA30 DC, CS tied to GND, reset tied to the
TinyDK reset. No SPI0, DMA, or pinmux is enabled.

## Build

```sh
arduino-cli compile --fqbn realtek:AmebaD:Ameba_AMB25 NU87_Usagi_LCD_Integration
```

`tools_make_ui_font.py` freezes the browser's fixed-cell UI-font scheme as
packed 4-bpp `PROGMEM` data in `ui_font_4bpp.h`. Re-run it after changing a
font cell size. The committed header is what firmware builds use.

## Pin map

Defined at the top of `firmware_impl.h`. Full wiring notes: [`../NU87_9Key_RGB_Test/WIRING.md`](../NU87_9Key_RGB_Test/WIRING.md).

| Function | Pin | Header | Notes |
|---|---|---|---|
| LCD SCK / MOSI | PB20 / PB18 | P2-8 / P2-10 | GPIO-register software SPI |
| LCD DC | PA30 (D4) | P1-6 | Must not be pulled low at power-up (strap pin) |
| LCD CS | GND | GND | Tied low |
| LCD RST | NU87_RESET | P2-14 | Shared with the board reset |
| LCD VCC / BL | 3.3 V | 3.3 V | |
| Key matrix rows R0 / R1 / R2 | PB1 / PB2 / PB23 | P2-6 / P2-5 / P2-13 | Scanned LOW, others `INPUT_PULLUP` |
| Key matrix columns C0 / C1 / C2 | PB22 / PA27 / PB3 | P2-12 / P1-5 / P2-7 | `INPUT_PULLUP`; SW1-SW3 = R0, SW4-SW6 = R1, SW7-SW9 = R2 |
| Encoder CLK / DT / SW | PB19 / PB21 / PA28 | P2-11 / P2-9 / P1-8 | 3.3 V only; `INPUT_PULLUP` |
| Screen button | PA7 | P2-16 | Active LOW, see below |
| RGB LED G / R / B | PA12 / PA13 / PA14 | P1-1 / P1-2 / P1-3 | Onboard, active HIGH |

## PA7 and runtime transport

AMB25 maps `LOG_TX` to PA7. The integrated firmware deliberately does **not**
call `Serial.begin()` and changes PA7 to `INPUT_PULLUP` only in `setup()`,
after ROM boot has completed. A debounced falling edge advances Home → Key
Mapping → RGB Settings → Home exactly once. USB-C remains usable for power and
upload; it is not a runtime data path in this build.

The first validation artifact is
[NU87_PA7_GPIO_Test](../NU87_PA7_GPIO_Test/NU87_PA7_GPIO_Test.ino).
It never starts LOG UART and toggles the red LED once per active-LOW PA7 press.
Verify boot, press polarity, reset, and re-upload with this sketch before
uploading the integration firmware.

### PA7 isolation order

The firmware defaults are the final target (`NU87_ENABLE_ANIMATION=1`,
`NU87_ENABLE_BLE=1`). For an on-board fault isolation build, change only these
defines at the top of `firmware_impl.h`, upload, and restore both to `1` after
the check:

1. `ANIMATION=0`, `BLE=0`: PA7 + static Home/Key Mapping only.
2. Keep those values and test SW1–SW9 and encoder editing.
3. `ANIMATION=1`, `BLE=0`: add Usagi.
4. `ANIMATION=1`, `BLE=1`: final BLE path.

`NU87_DIAG_HEARTBEAT_LED=1` makes green blink every 250 ms (proves `loop()` is
running); `NU87_DIAG_PA7_LED=1` flips red for each accepted debounced PA7
event. Neither mode starts LOG UART.

BLE Nordic UART Service is the runtime PC transport:

- Peripheral name: `NU87 Usagi`
- Service: `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
- Mac → board write: `6E400002-B5A3-F393-E0A9-E50E24DCCA9E`
- Board → Mac notify: `6E400003-B5A3-F393-E0A9-E50E24DCCA9E`

Use the same LF-terminated `TIME`, `WX`, and `AI` records below. Diagnostic
`BOOT`, `TRANSITION_PREP`, `SCREEN`, and `PERF` records are notified on TX
after the central enables notifications.

## Physical controls

- SW1–SW9 select an edit target on Key Mapping; on Home they retain
  single/double/hold mapping gestures.
- Encoder rotation moves the cursor; click enters/chooses/confirms; long press
  goes back/cancels while editing.
- PA7 short click cycles Home → Key Mapping → RGB Settings → Home.
- RGB Settings: rotate to select Effect, Color, Brightness (5%), Speed (0.5–5.0 s),
  Save or Cancel; click edits/confirms and long press cancels or returns Home.

## Persistence and companion input

The core's `Preferences` API stores CRC-protected `keymap` and `rgb` blobs in
the `nu87-ui` namespace. It writes only after **Save** (or profile change),
never while the encoder turns. Boot logs report `NVM_RESTORE` or `NVM_DEFAULTS`.

BLE RX is line based, intentionally separate from drawing:

```text
TIME,10,24,1,17,10
WX,clear,18,Seoul
AI,claude,thinking
AI,codex,idle
```

`TIME` is retained by a local minute ticker between sync records. Until a
record is received, the display labels its deterministic Seoul sample as
`MOCK DATA`.

## Instrumentation

`TRANSITION_PREP`, `SCREEN`, `UI_PAINT`, `PERF`, and `NVM_SAVE` are BLE-TX
notifications. They report changed pixels/bytes, transition duration,
animation dirty-cell/run count, transfer time/bytes, UI paint time, and RAM
buffers. Screen transitions no longer send ST7796S Display Off/On and do not
reinitialize or reset the panel; the existing image remains visible while
opaque dirty regions are composed.

For transition benchmarking, capture the two BLE notifications produced by one
PA7 click:

```text
TRANSITION_PREP target=... pixels=... bytes=... us=... cells=...
SCREEN KEYMAP|HOME EVENT_TO_START_US ... TRANSITION_US ... EVENT_TO_DONE_US ... ACTUAL_WIRE_BYTES ... WINDOWS ... FONT_PREP_US ...
```

`ACTUAL_WIRE_BYTES` counts every command and RGB565 byte emitted by the GPIO
SPI path; `WINDOWS` is the number of address-window transactions. Compare ten
Home→Keymap clicks and ten Keymap→Home clicks after animation has settled.
The previous Home HUD clear alone was 48,480 pixels (96,960 RGB565 bytes); it
is now six exact widgets totaling 22,898 pixels (45,796 payload bytes), before
the variable Usagi-run saving is included.

Key Mapping local updates emit `KEYMAP_UPDATE`. With no pending widget dirty
bits, the Key Mapping idle loop performs no LCD transfer. Encoder selection
changes repaint only the old/new cursor bars and labels; screen/stage changes
emit an opaque right-panel repaint so stale glyphs cannot survive.

Send `BENCH` to BLE RX to measure three solid RGB565 transfers. BLE TX reports
`LCD_BENCH` for 100×50, 200×100 and 480×320, including bytes, address windows,
microseconds and effective bytes/s. The screen is then rebuilt from current
state. `KEYMAP_EVENT` reports state/layout time and encoder-event-to-LCD-done.

The RGB LED reuses the verified active-HIGH values from `NU87_9Key_RGB_Test`:
Red, Deep Orange, Yellow, Green, Blue, Indigo, Cyan, Hot Pink and White. The
lowest numbered held key is the deterministic priority; while any key is down
it overrides Ambient RGB, and on release the saved Off/Static/Breathing/Pastel
Cycle setting resumes. PWM is non-blocking and is serviced from both the main
loop and long LCD byte streams.
