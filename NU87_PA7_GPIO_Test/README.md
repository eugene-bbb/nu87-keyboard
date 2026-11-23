# PA7 GPIO acceptance test

1. Upload `NU87_PA7_GPIO_Test.ino` to AMB25 with USB-C attached.
2. Confirm the board boots normally and the red LED is initially off.
3. Press the actual PA7 button: the red LED must toggle exactly once per press.
4. Hold the button: it must not repeatedly toggle.
5. Reset the board while the button is released, then re-upload this sketch.

The sketch has no `Serial.begin()` and makes no eFuse, bootloader, or strap
change. If reset/upload fails or the LED does not follow the expected active-
LOW behavior, stop: do not use the integrated PA7 firmware until the physical
button circuit is corrected or its polarity is remeasured.
