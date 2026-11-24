# NU87-TinyDK wiring

Pin map verified against `NU87_Usagi_LCD_Integration/firmware_impl.h` (the final
firmware). The "Checks" section at the bottom applies to the
`NU87_9Key_RGB_Test` sketch only.

## Conflict-checked allocation

| Function | RTL8720DF pin | Header | Note |
|---|---:|---:|---|
| RGB G / R / B | PA12 / PA13 / PA14 | P1-1 / P1-2 / P1-3 | Onboard, active HIGH; software PWM because PA14 has no PWM |
| PA7 screen button | PA7 (LOG_TX) | P2-16 | `INPUT_PULLUP`, active LOW (button to GND). The final firmware never starts `Serial`; only `NU87_9Key_RGB_Test` uses the PA7/PA8 CP2102 UART |
| Matrix rows R0/R1/R2 | PB1 / PB2 / PB23 | P2-6 / P2-5 / P2-13 | Scan as LOW output; unselected rows stay `INPUT_PULLUP` (floating rows cause false SW7 reads) |
| Matrix cols C0/C1/C2 | PB22 / PA27 / PB3 | P2-12 / P1-5 / P2-7 | `INPUT_PULLUP`, pressed = LOW |
| TFT MOSI / SCK / DC | PB18 / PB20 / PA30 (D4) | P2-10 / P2-8 / P1-6 | Software SPI only (GPIO register path) |
| TFT CS | GND | GND | Tied low, no GPIO used |
| TFT RST | NU87_RESET | P2-14 or P3-4 | Hard-wire; saves one GPIO |
| KY-040 CLK / DT / SW | PB19 / PB21 / PA28 | P2-11 / P2-9 / P1-8 | 3.3 V only; all `INPUT_PULLUP`; CLK and DT use change interrupts, SW is active LOW |

Do not use PA28 for native USB while it is the KY-040 SW. PA27/PB3 are SWD pins;
`pinMode()` disables SWD. PA27 is also connected to onboard SW3, so pressing
SW3 appears as a matrix-column press. PA30 (TFT DC, D4) has an on-module 10 kohm pull-up and is a power-on
strap pin: the LCD DC input must not pull it low at power-up.

The AmebaD hardware `SPI` instance occupies PB18=MOSI, PB19=MISO, PB20=SCK and
PB21=SS. That conflicts with KY-040 CLK on PB19 and DT on PB21, so the TFT uses
write-only software SPI on PB18/PB20/PA30 with CS tied to GND. Never silently
select hardware SPI here.

## LCD (ST7796S) pins

| LCD pin | NU87-TinyDK GPIO | Board header |
|---|---|---|
| VCC | 3.3 V | 3.3 V |
| GND | GND | GND |
| SCK / CLK | PB20 | P2-8 |
| SDA / MOSI | PB18 | P2-10 |
| DC / RS | PA30 (D4) | P1-6 |
| CS | GND | GND |
| RST / RESET | NU87_RESET | P2-14 |
| BL / LED | 3.3 V | 3.3 V |

## Rotary encoder (KY-040) pins

| Encoder pin | NU87-TinyDK GPIO | Function |
|---|---|---|
| CLK | PB19 | Rotation signal A |
| DT | PB21 | Rotation signal B |
| SW | PA28 | Knob click |
| + | 3.3 V | Power (never 5 V) |
| GND | GND | Ground |

## Switch matrix

| | C0 PB22 (P2-12) | C1 PA27 (P1-5) | C2 PB3 (P2-7) |
|---|---|---|---|
| R0 PB1 (P2-6) | SW1 | SW2 | SW3 |
| R1 PB2 (P2-5) | SW4 | SW5 | SW6 |
| R2 PB23 (P2-13) | SW7 | SW8 | SW9 |

For each 2-pin switch, connect one terminal to its row and the other to its
column. No terminal goes directly to GND or 3V3. With no per-switch diodes,
multi-key patterns spanning both multiple rows and multiple columns are
electrically ambiguous; the sketch reports `GHOST_BLOCK` and turns the LED off.
Multiple keys in a single row or column are accepted and the lowest SW number
wins.

## Checks (`NU87_9Key_RGB_Test` sketch)

1. With power off, verify no matrix wire is shorted to 3V3/GND and PA28 is not
   about 12 kohm to GND. If it is, inspect the USB-mode resistor population
   before using PA28 as the encoder switch.
2. Compile for `realtek:AmebaD:Ameba_AMB25`, upload, and open Serial Monitor at
   115200 baud. Expect `NU87_9KEY_READY`.
3. Hold SW1..SW9 one at a time. Expect the specified fixed colour and one
   `SWn #RRGGBB` line; release must blank the LED within one 3 ms scan frame.
4. Hold two keys in the same row/column: the lower number wins. Test a rectangle
   pattern: expect `GHOST_BLOCK` and LED off, never a phantom colour.
5. If colours are swapped, stop and recheck the board revision/schematic. This
   schematic drives a common-cathode RGB through non-inverting buffers, so
   PA12=G, PA13=R, PA14=B and HIGH means on.
