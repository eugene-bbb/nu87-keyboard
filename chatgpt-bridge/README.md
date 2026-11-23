# ChatGPT encoder bridge (early prototype)

Rotary encoder + one button on an NU87-TinyDK drive the macOS ChatGPT app over USB serial: rotate to change the reasoning level, press to confirm, and the blue switch sends Return. Superseded by the BLE-based [NU87 Companion](../NU87_Companion), kept for reference.

## Wiring

| Part | NU87-TinyDK |
|---|---|
| Blue switch | PB2—GND |
| RGB LED | PA12(G), PA13(R), PA14(B) |
| KY-040 CLK | PB20 |
| KY-040 DT | PB21 |
| KY-040 SW | PB22 |
| KY-040 power | 3V3, GND |

CLK/DT/SW use `INPUT_PULLUP`. Do not connect KY-040 VCC to 5 V.

## Upload

```bash
arduino-cli board list
arduino-cli compile --fqbn realtek:AmebaD:Ameba_AMB25 NU87_Rainbow_Switch
arduino-cli upload -p /dev/cu.usbserial-XXXXXXXX --fqbn realtek:AmebaD:Ameba_AMB25 NU87_Rainbow_Switch
```

## Install and run

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python chatgpt_serial_enter.py
```

Do not open Arduino Serial Monitor at the same time. The bridge auto-detects CP2102 and reconnects after unplug/replug. Override when needed:

```bash
python chatgpt_serial_enter.py --port /dev/cu.usbserial-XXXXXXXX
```

In **System Settings → Privacy & Security → Accessibility**, enable the terminal used to run Python, then restart that terminal. ChatGPT must be frontmost.

## Test

1. Check serial events without UI input: `python chatgpt_serial_enter.py --dry-run`. One detent prints one `ENC_CW` or `ENC_CCW`; KY-040 SW prints only `ENC_CLICK`; the blue switch prints only `BUTTON`.
2. Make ChatGPT frontmost and verify discovery: `python chatgpt_serial_enter.py --inspect-ui`. It must show the reasoning trigger. If an app update renames it, pass its accessible label with `--trigger-name`.
3. Run normally. Rotating the KY-040 opens the reasoning menu and moves one step per detent, clamped at the first/last step.
4. Press KY-040 to keep the value and close the menu. With the menu closed, it does nothing.
5. Type unsent text and press the blue switch: Return sends it. Holding the switch keeps the RGB rainbow running; release turns the LED off.
6. With another app frontmost, no ChatGPT UI input is generated.
7. Unplug/replug CP2102 and confirm the bridge reconnects.

ChatGPT build `26.1029.61003` exposes a six-step Power control rather than a normal option list; the bridge drives its left/right actions directly. Builds exposing a normal Instant/Medium/High menu use the accessibility-label discovery path.
