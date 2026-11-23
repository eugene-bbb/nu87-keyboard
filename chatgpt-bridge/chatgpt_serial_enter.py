#!/usr/bin/env python3
"""Bridge NU87 button/encoder events to the frontmost ChatGPT macOS app."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

import serial
from AppKit import NSRunningApplication, NSWorkspace
from ApplicationServices import (
    AXIsProcessTrustedWithOptions,
    AXUIElementCopyAttributeValue,
    AXUIElementCreateApplication,
    AXUIElementCreateSystemWide,
    AXUIElementPerformAction,
    AXValueGetValue,
    kAXChildrenAttribute,
    kAXDescriptionAttribute,
    kAXEnabledAttribute,
    kAXHelpAttribute,
    kAXHiddenAttribute,
    kAXIdentifierAttribute,
    kAXParentAttribute,
    kAXPositionAttribute,
    kAXPressAction,
    kAXRoleAttribute,
    kAXSelectedAttribute,
    kAXShowMenuAction,
    kAXSizeAttribute,
    kAXTitleAttribute,
    kAXTrustedCheckOptionPrompt,
    kAXValueAttribute,
    kAXValueCGPointType,
    kAXValueCGSizeType,
    kAXFocusedUIElementAttribute,
)
from Quartz import (
    CGEventCreateKeyboardEvent,
    CGEventCreateMouseEvent,
    CGEventPost,
    CGWindowListCopyWindowInfo,
    kCGNullWindowID,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGHIDEventTap,
    kCGMouseButtonLeft,
    kCGWindowAlpha,
    kCGWindowBounds,
    kCGWindowLayer,
    kCGWindowListOptionOnScreenOnly,
    kCGWindowOwnerPID,
)
from serial.tools import list_ports


BAUD_RATE = 115200
CP2102_VID = 0x10C4
CP2102_PID = 0xEA60
RECONNECT_DELAY_SECONDS = 1.0
MENU_OPEN_TIMEOUT_SECONDS = 0.8

BUTTON_EVENTS = {"BUTTON", "PRESS"}  # PRESS keeps old firmware compatible.
ROTATION_EVENTS = {"ENC_CW", "ENC_CCW"}
ENCODER_CLICK_EVENT = "ENC_CLICK"

KEY_RETURN = 36
KEY_ESCAPE = 53
KEY_DOWN = 125
KEY_UP = 126
KEY_LEFT = 123
KEY_RIGHT = 124

BUTTON_ROLES = {"AXButton", "AXMenuButton", "AXPopUpButton"}
OPTION_ROLES = {
    "AXButton",
    "AXCheckBox",
    "AXMenuItem",
    "AXRadioButton",
    "AXRow",
}
TRIGGER_WORDS = (
    "reasoning",
    "reasoning effort",
    "thinking",
    "inference",
    "추론",
    "사고",
    "생각",
)
MENU_WORDS = TRIGGER_WORDS + ("추론 수준 선택", "select reasoning level")
MENU_TITLES = {
    "추론 수준 선택",
    "select reasoning level",
    "reasoning level",
    "reasoning effort",
}
POWER_ITEM_NAMES = {"power", "파워"}
OPTION_NAMES = {
    "instant",
    "auto",
    "automatic",
    "minimal",
    "low",
    "medium",
    "high",
    "extra high",
    "extra-high",
    "xhigh",
    "max",
    "fast",
    "thinking",
    "즉시",
    "자동",
    "낮음",
    "보통",
    "중간",
    "높음",
    "최고",
}


def log(message: str) -> None:
    print(message, flush=True)


def chatgpt_bundle_id() -> str:
    result = subprocess.run(
        ["osascript", "-e", 'id of application "ChatGPT"'],
        check=True,
        capture_output=True,
        text=True,
    )
    bundle_id = result.stdout.strip()
    if not bundle_id:
        raise RuntimeError("ChatGPT application bundle ID was not found")
    return bundle_id


def choose_port(explicit_port: str | None) -> str | None:
    if explicit_port:
        return explicit_port if Path(explicit_port).exists() else None
    matches = [
        port.device
        for port in list_ports.comports()
        if port.vid == CP2102_VID and port.pid == CP2102_PID
    ]
    if not matches:
        return None
    matches.sort(
        key=lambda name: (
            0 if Path(name).name.startswith("cu.usbserial-") else 1,
            name,
        )
    )
    return matches[0]


def ax_get(element, attribute):
    error, value = AXUIElementCopyAttributeValue(element, attribute, None)
    return value if error == 0 else None


def normalize(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def element_text(element) -> str:
    values: list[str] = []
    normalized: set[str] = set()
    for attribute in (
        kAXTitleAttribute,
        kAXDescriptionAttribute,
        kAXHelpAttribute,
        kAXIdentifierAttribute,
        kAXValueAttribute,
    ):
        value = ax_get(element, attribute)
        if isinstance(value, str) and normalize(value) not in normalized:
            values.append(value.strip())
            normalized.add(normalize(value))
    return " | ".join(item for item in values if item)


def walk_tree(root, max_nodes: int = 5000):
    queue = deque([root])
    count = 0
    while queue and count < max_nodes:
        element = queue.popleft()
        count += 1
        yield element
        children = ax_get(element, kAXChildrenAttribute)
        if children:
            queue.extend(children)


def role_of(element) -> str:
    return str(ax_get(element, kAXRoleAttribute) or "")


def is_available(element) -> bool:
    hidden = ax_get(element, kAXHiddenAttribute)
    enabled = ax_get(element, kAXEnabledAttribute)
    return hidden is not True and enabled is not False


def option_name(text: str) -> str | None:
    for part in (normalize(item) for item in text.split("|")):
        cleaned = re.sub(r"[✓✔●•]\s*", "", part).strip(" :-")
        if cleaned in OPTION_NAMES:
            return cleaned
        # Current ChatGPT builds expose a combined trigger such as
        # "GPT-5.6 Sol Medium" rather than a button named only "Medium".
        for name in sorted(OPTION_NAMES, key=len, reverse=True):
            if re.search(rf"(?:^|\s){re.escape(name)}$", cleaned):
                return name
    return None


@dataclass
class MenuOption:
    element: object
    name: str
    selected: bool


@dataclass
class PowerState:
    label: str
    index: int
    count: int


def parse_power_state(text: str) -> PowerState | None:
    korean = re.search(r"^(.+?),\s*(\d+)\s*개 중\s*(\d+)\s*번째", text)
    if korean:
        return PowerState(korean.group(1).strip(), int(korean.group(3)), int(korean.group(2)))
    english = re.search(r"^(.+?),\s*(\d+)\s+of\s+(\d+)", text, re.IGNORECASE)
    if english:
        return PowerState(
            english.group(1).strip(), int(english.group(2)), int(english.group(3))
        )
    return None


def click_element_center(element) -> bool:
    position_value = ax_get(element, kAXPositionAttribute)
    size_value = ax_get(element, kAXSizeAttribute)
    if position_value is None or size_value is None:
        return False
    position_ok, position = AXValueGetValue(
        position_value, kAXValueCGPointType, None
    )
    size_ok, size = AXValueGetValue(size_value, kAXValueCGSizeType, None)
    if not position_ok or not size_ok or size.width <= 0 or size.height <= 0:
        return False
    point = (position.x + size.width / 2, position.y + size.height / 2)
    for event_type in (kCGEventLeftMouseDown, kCGEventLeftMouseUp):
        event = CGEventCreateMouseEvent(
            None, event_type, point, kCGMouseButtonLeft
        )
        CGEventPost(kCGHIDEventTap, event)
    return True


def show_candidate(candidate: int, count: int) -> None:
    script = """
on run argv
    display notification (item 1 of argv) with title "ChatGPT 추론 수준"
end run
"""
    subprocess.run(
        ["osascript", "-e", script, "--", f"선택 후보: {candidate} / {count}"],
        capture_output=True,
        text=True,
        check=False,
    )


class ChatGPTController:
    def __init__(self, bundle_id: str, trigger_name: str | None = None):
        self.bundle_id = bundle_id
        self.trigger_name = normalize(trigger_name) if trigger_name else None
        self.pending_power_index: int | None = None
        self.pending_power_count: int | None = None

    def frontmost_application(self):
        # NSWorkspace can retain the application that was active when a
        # long-running, non-GUI Python process started. Window Server returns a
        # live front-to-back list and therefore reflects every focus change.
        options = kCGWindowListOptionOnScreenOnly
        windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) or []
        for window in windows:
            if int(window.get(kCGWindowLayer, -1)) != 0:
                continue
            if float(window.get(kCGWindowAlpha, 0.0)) <= 0:
                continue
            bounds = window.get(kCGWindowBounds) or {}
            if float(bounds.get("Width", 0)) < 50 or float(bounds.get("Height", 0)) < 50:
                continue
            pid = int(window.get(kCGWindowOwnerPID, 0))
            app = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
            if app is not None:
                return app
        return NSWorkspace.sharedWorkspace().frontmostApplication()

    def is_frontmost(self) -> bool:
        app = self.frontmost_application()
        return bool(app and app.bundleIdentifier() == self.bundle_id)

    def frontmost_description(self) -> str:
        app = self.frontmost_application()
        if app is None:
            return "unknown application"
        name = str(app.localizedName() or "unknown")
        bundle_id = str(app.bundleIdentifier() or "no bundle ID")
        return f"{name} ({bundle_id})"

    def not_frontmost_message(self) -> str:
        return f"ignored: frontmost is {self.frontmost_description()}"

    def application_element(self):
        apps = NSWorkspace.sharedWorkspace().runningApplications()
        for app in apps:
            if app.bundleIdentifier() == self.bundle_id:
                return AXUIElementCreateApplication(app.processIdentifier())
        return None

    def _nodes(self) -> list[object]:
        app = self.application_element()
        return list(walk_tree(app)) if app is not None else []

    def find_trigger(self, nodes: list[object]):
        explicit: list[object] = []
        strong_popup: list[object] = []
        generic_labeled: list[object] = []
        option_labeled: list[object] = []
        option_popup: list[object] = []
        for element in nodes:
            role = role_of(element)
            if role not in BUTTON_ROLES or not is_available(element):
                continue
            text = normalize(element_text(element))
            if self.trigger_name and self.trigger_name in text:
                explicit.append(element)
            if text in MENU_TITLES:
                generic_labeled.append(element)
            if role in {"AXMenuButton", "AXPopUpButton"} and any(
                word in text for word in TRIGGER_WORDS
            ):
                strong_popup.append(element)
            if option_name(text):
                option_labeled.append(element)
                if role in {"AXMenuButton", "AXPopUpButton"}:
                    option_popup.append(element)

        if self.trigger_name:
            return explicit[0] if len(explicit) == 1 else None
        if len(option_popup) == 1:
            return option_popup[0]
        if len(strong_popup) == 1:
            return strong_popup[0]
        if len(generic_labeled) == 1:
            return generic_labeled[0]
        # Some versions expose only the current value (for example "Medium").
        return option_labeled[0] if len(option_labeled) == 1 else None

    def find_options(self, nodes: list[object]) -> list[MenuOption]:
        found: dict[str, MenuOption] = {}
        for element in nodes:
            name = option_name(element_text(element))
            if not name or not is_available(element):
                continue

            interactive = element
            for _ in range(4):
                if role_of(interactive) in OPTION_ROLES:
                    break
                parent = ax_get(interactive, kAXParentAttribute)
                if parent is None:
                    break
                interactive = parent
            if role_of(interactive) not in OPTION_ROLES:
                continue

            selected = ax_get(interactive, kAXSelectedAttribute) is True
            value = ax_get(interactive, kAXValueAttribute)
            selected = selected or value is True or value == 1
            found[name] = MenuOption(interactive, name, selected)

        # A closed UI commonly exposes one current-value button. Requiring two
        # options prevents an encoder click from sending Return to the composer.
        return list(found.values()) if len(found) >= 2 else []

    def visible_options(self) -> list[MenuOption]:
        return self._menu_state()[0]

    def power_state(self) -> PowerState | None:
        return self._menu_state()[1]

    def _post_key(self, key_code: int) -> bool:
        if not self.is_frontmost():
            return False
        down = CGEventCreateKeyboardEvent(None, key_code, True)
        up = CGEventCreateKeyboardEvent(None, key_code, False)
        CGEventPost(kCGHIDEventTap, down)
        CGEventPost(kCGHIDEventTap, up)
        return True

    def _menu_state(self) -> tuple[list[MenuOption], PowerState | None]:
        nodes = self._nodes()
        # Scope detection to the reasoning popup. This excludes persistent
        # macOS menu-bar items and words appearing in chat transcript text.
        for root in nodes:
            if role_of(root) not in {"AXGroup", "AXMenu", "AXPopover"}:
                continue
            if normalize(element_text(root)) not in MENU_TITLES:
                continue
            subtree = list(walk_tree(root, max_nodes=300))
            power = next(
                (
                    state
                    for element in subtree
                    if role_of(element) == "AXStaticText"
                    for state in [parse_power_state(element_text(element))]
                    if state is not None
                ),
                None,
            )
            options = self.find_options(subtree)
            if options or power:
                return options, power

        # Native menu builds may not give the popup a titled container.
        for root in nodes:
            if role_of(root) != "AXMenu":
                continue
            options = self.find_options(list(walk_tree(root, max_nodes=200)))
            if options:
                return options, None
        return [], None

    def open_menu(self) -> list[MenuOption]:
        if not self.is_frontmost():
            raise RuntimeError("ChatGPT is not frontmost")
        options, power = self._menu_state()
        if options or power:
            return options

        nodes = self._nodes()
        trigger = self.find_trigger(nodes)
        if trigger is None:
            raise RuntimeError(
                "reasoning trigger not found (use --trigger-name if its label changed)"
            )
        action = (
            kAXShowMenuAction
            if role_of(trigger) in {"AXMenuButton", "AXPopUpButton"}
            else kAXPressAction
        )
        error = AXUIElementPerformAction(trigger, action)
        first_deadline = time.monotonic() + 0.18
        while error == 0 and time.monotonic() < first_deadline:
            if not self.is_frontmost():
                break
            time.sleep(0.03)
            options, power = self._menu_state()
            if options or power:
                return options

        # Electron currently advertises AXShowMenu on its model selector but
        # does not open it. A click at the AX-reported bounds is the minimal
        # coordinate fallback and contains no hard-coded screen position.
        if not click_element_center(trigger):
            raise RuntimeError(
                f"reasoning trigger action failed ({error}); no AX bounds fallback"
            )

        deadline = time.monotonic() + MENU_OPEN_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            if not self.is_frontmost():
                break
            time.sleep(0.04)
            options, power = self._menu_state()
            if options or power:
                return options
        raise RuntimeError("menu opened but accessible reasoning options were not found")

    def rotate(self, clockwise: bool) -> str:
        if not self.is_frontmost():
            self.pending_power_index = None
            return self.not_frontmost_message()
        options, power = self._menu_state()
        if not options and power is None:
            self.open_menu()
            options, power = self._menu_state()
        if power:
            if not self._focus_power_item():
                return "ignored: power control could not be focused"
            if not self._post_key(KEY_RIGHT if clockwise else KEY_LEFT):
                return "ignored: ChatGPT lost focus"
            time.sleep(0.07)
            applied = self.power_state()
            if applied is None:
                return "ignored: power control state could not be verified"
            if applied.index == power.index:
                return f"at boundary: {applied.label} ({applied.index}/{applied.count})"
            return f"applied: {applied.label} ({applied.index}/{applied.count})"

        before = next((item.name for item in options if item.selected), "current")
        if not self._post_key(KEY_DOWN if clockwise else KEY_UP):
            return "ignored: ChatGPT lost focus"
        time.sleep(0.04)
        return f"candidate moved {'next' if clockwise else 'previous'} from {before}"

    def _focus_power_item(self) -> bool:
        system = AXUIElementCreateSystemWide()
        for _ in range(12):
            focused = ax_get(system, kAXFocusedUIElementAttribute)
            if normalize(element_text(focused)) in POWER_ITEM_NAMES:
                return True
            if not self._post_key(KEY_DOWN):
                return False
            time.sleep(0.04)
        return False

    def confirm(self) -> str:
        if not self.is_frontmost():
            self.pending_power_index = None
            return self.not_frontmost_message()
        options, power = self._menu_state()
        if not options and power is None:
            self.pending_power_index = None
            return "ignored: verified reasoning menu is not open"
        if options:
            if not self._post_key(KEY_RETURN):
                return "ignored: ChatGPT lost focus"
            return "reasoning level applied"

        assert power is not None
        if not self._post_key(KEY_ESCAPE):
            return "ignored: ChatGPT lost focus"
        self.pending_power_index = None
        self.pending_power_count = None
        return f"reasoning menu closed: {power.label} ({power.index}/{power.count})"

    def send_message(self) -> str:
        if not self.is_frontmost():
            self.pending_power_index = None
            return self.not_frontmost_message()

        # Never let the blue-switch Return confirm a pending encoder choice.
        options, power = self._menu_state()
        if options or power is not None:
            self._post_key(KEY_ESCAPE)
            self.pending_power_index = None
            self.pending_power_count = None
            time.sleep(0.06)
        if not self._post_key(KEY_RETURN):
            return "ignored: ChatGPT lost focus"
        return "message Return sent"

    def inspect(self) -> None:
        nodes = self._nodes()
        trigger = self.find_trigger(nodes)
        options, power = self._menu_state()
        log(f"frontmost={self.is_frontmost()} nodes={len(nodes)}")
        log(f"trigger={element_text(trigger) if trigger is not None else 'NOT FOUND'}")
        if power:
            log(f"power={power.label} ({power.index}/{power.count})")
        else:
            log(
                "options="
                + (", ".join(item.name for item in options) or "menu closed/not found")
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Bridge NU87 CP2102 button/encoder events to ChatGPT"
    )
    parser.add_argument("--port", help="serial device override")
    parser.add_argument("--bundle-id", help="ChatGPT bundle ID override")
    parser.add_argument(
        "--trigger-name",
        help="unique text exposed by the reasoning menu button",
    )
    parser.add_argument(
        "--inspect-ui",
        action="store_true",
        help="inspect the frontmost ChatGPT accessibility tree and exit",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print serial events without controlling ChatGPT",
    )
    return parser.parse_args()


def handle_event(controller: ChatGPTController, event: str, dry_run: bool) -> None:
    if event not in BUTTON_EVENTS | ROTATION_EVENTS | {ENCODER_CLICK_EVENT}:
        return
    if dry_run:
        log(f"{event} -> dry-run")
        return
    try:
        if event in BUTTON_EVENTS:
            outcome = controller.send_message()
        elif event == "ENC_CW":
            outcome = controller.rotate(clockwise=True)
        elif event == "ENC_CCW":
            outcome = controller.rotate(clockwise=False)
        else:
            outcome = controller.confirm()
        log(f"{event} -> {outcome}")
    except RuntimeError as exc:
        log(f"{event} ignored: {exc}")


def main() -> int:
    args = parse_args()
    try:
        bundle_id = args.bundle_id or chatgpt_bundle_id()
    except (OSError, subprocess.CalledProcessError, RuntimeError) as exc:
        log(f"ERROR: cannot identify ChatGPT: {exc}")
        return 1

    controller = ChatGPTController(bundle_id, args.trigger_name)
    log(f"ChatGPT bundle ID: {bundle_id}")

    if not args.dry_run:
        trusted = AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: True})
        if not trusted:
            log("ERROR: grant Accessibility permission, then restart this program")
            return 2

    if args.inspect_ui:
        if not controller.is_frontmost():
            log("ERROR: make ChatGPT frontmost before --inspect-ui")
            return 3
        controller.inspect()
        return 0

    if args.dry_run:
        log("Dry-run mode: no UI input will be generated")

    while True:
        port = choose_port(args.port)
        if port is None:
            log("Waiting for NU87 CP2102...")
            time.sleep(RECONNECT_DELAY_SECONDS)
            continue

        try:
            with serial.Serial(port, BAUD_RATE, timeout=0.5) as device:
                device.reset_input_buffer()
                device.write(b"HOST_READY\n")
                device.flush()
                log(f"Connected: {port} @ {BAUD_RATE} bps")
                while True:
                    line = device.readline().decode("ascii", errors="ignore").strip()
                    if line.startswith("READY "):
                        log(f"Device {line}")
                    elif line:
                        handle_event(controller, line, args.dry_run)
        except (serial.SerialException, OSError) as exc:
            log(f"Serial disconnected ({exc}); reconnecting...")
            time.sleep(RECONNECT_DELAY_SECONDS)
        except KeyboardInterrupt:
            log("Stopped")
            return 0


if __name__ == "__main__":
    sys.exit(main())
