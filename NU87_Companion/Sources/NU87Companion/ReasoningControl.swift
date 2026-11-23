import AppKit
import ApplicationServices

/// Controls the reasoning level of the conversation open in the frontmost ChatGPT/Codex desktop app through the macOS Accessibility API
/// (the same approach as the earlier chatgpt_serial_enter.py test): find the reasoning/model trigger in the app's accessibility tree, open its menu,
/// move the "power" slider with arrow keys and read the state back. No fixed screen coordinates and no private app API.
/// Keys are only ever posted while ChatGPT is the frontmost app.
enum AXu {
    static func get(_ e: AXUIElement, _ a: String) -> AnyObject? { var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil }
    static func str(_ e: AXUIElement, _ a: String) -> String? { get(e, a) as? String }
    static func role(_ e: AXUIElement) -> String { str(e, kAXRoleAttribute) ?? "" }
    static func children(_ e: AXUIElement) -> [AXUIElement] { (get(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
    static func norm(_ s: String) -> String { s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").lowercased() }
    /// title | description | help | identifier | value, de-duplicated
    static func text(_ e: AXUIElement) -> String {
        var out = [String](), seen = Set<String>()
        for a in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, kAXIdentifierAttribute, kAXValueAttribute] {
            if let v = str(e, a)?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty, seen.insert(norm(v)).inserted { out.append(v) }
        }
        return out.joined(separator: " | ")
    }
    static func available(_ e: AXUIElement) -> Bool { (get(e, kAXHiddenAttribute) as? Bool) != true && (get(e, kAXEnabledAttribute) as? Bool) != false }
    static func walk(_ root: AXUIElement, max: Int = 5000, _ visit: (AXUIElement) -> Void) {
        var q = [root], i = 0, n = 0
        while i < q.count, n < max { let e = q[i]; i += 1; n += 1; visit(e); q.append(contentsOf: children(e)) }
    }
}

final class ReasoningControl {
    static let shared = ReasoningControl()
    static let bundleID = "com.openai.codex"
    static let triggerWords = ["reasoning", "reasoning effort", "thinking", "inference", "추론", "사고", "생각"]
    static let menuTitles: Set<String> = ["추론 수준 선택", "select reasoning level", "reasoning level", "reasoning effort"]
    static let optionNames = ["instant", "auto", "automatic", "minimal", "low", "medium", "high", "extra high", "extra-high", "xhigh", "max", "ultra", "fast", "thinking", "즉시", "자동", "낮음", "보통", "중간", "높음", "최고"]
    struct Power { var label: String; var index: Int; var count: Int }

    var frontmost: NSRunningApplication? { NSWorkspace.shared.frontmostApplication }
    var isFrontmost: Bool { frontmost?.bundleIdentifier == ReasoningControl.bundleID }
    var app: AXUIElement? { NSRunningApplication.runningApplications(withBundleIdentifier: ReasoningControl.bundleID).first.map { AXUIElementCreateApplication($0.processIdentifier) } }

    static func optionName(_ text: String) -> String? {
        for part in text.split(separator: "|").map({ AXu.norm(String($0)) }) {
            let c = part.replacingOccurrences(of: "[✓✔●•]\\s*", with: "", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: " :-"))
            if optionNames.contains(c) { return c }
            for n in optionNames.sorted(by: { $0.count > $1.count }) where c.hasSuffix(" " + n) || c == n { return n }   // "GPT-5.6 Sol Medium"
        }
        return nil
    }
    static func parsePower(_ t: String) -> Power? {
        if let m = try? NSRegularExpression(pattern: "^(.+?),\\s*(\\d+)\\s*개 중\\s*(\\d+)\\s*번째").firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) {
            let g = (1...3).map { String(t[Range(m.range(at: $0), in: t)!]) }; return Power(label: g[0], index: Int(g[2])!, count: Int(g[1])!)
        }
        if let m = try? NSRegularExpression(pattern: "^(.+?),\\s*(\\d+)\\s+of\\s+(\\d+)", options: .caseInsensitive).firstMatch(in: t, range: NSRange(t.startIndex..., in: t)) {
            let g = (1...3).map { String(t[Range(m.range(at: $0), in: t)!]) }; return Power(label: g[0], index: Int(g[1])!, count: Int(g[2])!)
        }
        return nil
    }

    /// Read-only description of what the app exposes (used by the local debug endpoint and by tests).
    func inspect() -> [String: Any] {
        guard AXIsProcessTrusted() else { return ["error": "Accessibility not granted"] }
        guard let app = app else { return ["error": "ChatGPT is not running"] }
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)   // Electron exposes its full accessibility tree only after this is set
        var info: [String: Any] = ["frontmost": frontmost?.bundleIdentifier ?? "?", "chatgptFrontmost": isFrontmost]
        var nodes = 0, triggers = [[String: String]](), windows = [String](), buttons = [String](), likely = [String]()
        AXu.walk(app) { e in
            nodes += 1; let r = AXu.role(e), t = AXu.text(e)
            if r == "AXWindow" { windows.append(AXu.str(e, kAXTitleAttribute) ?? "") }
            if t.range(of: "gpt|terra|sol |luna|astra|추론|reason|effort|낮음|보통|높음|medium|extra", options: [.regularExpression, .caseInsensitive]) != nil, likely.count < 60 { likely.append("\(r): \(String(t.prefix(90)))") }
            guard ["AXButton", "AXMenuButton", "AXPopUpButton"].contains(r), AXu.available(e) else { return }
            var y = -1.0; if let pv = AXu.get(e, kAXPositionAttribute) { var pt = CGPoint.zero; AXValueGetValue(pv as! AXValue, .cgPoint, &pt); y = pt.y }
            if buttons.count < 600 { buttons.append("\(Int(y)) \(r): \(String(t.prefix(70)))") }
            let n = AXu.norm(t)
            if ReasoningControl.menuTitles.contains(n) || ReasoningControl.triggerWords.contains(where: { n.contains($0) }) || ReasoningControl.optionName(n) != nil { triggers.append(["role": r, "text": t]) }
        }
        info["nodes"] = nodes; info["windows"] = windows; info["triggerCandidates"] = triggers; info["buttons"] = buttons; info["likely"] = likely
        // Everything around the composer text area (where the model / reasoning selector lives)
        var areas = [AXUIElement](); AXu.walk(app) { if AXu.role($0) == "AXTextArea", AXu.text($0).hasPrefix("작성을 시작하세요") || AXu.text($0).lowercased().hasPrefix("ask") { areas.append($0) } }
        if let ta = areas.last {
            var up = ta; for _ in 0..<5 { if let p = AXu.get(up, kAXParentAttribute) { up = p as! AXUIElement } }
            var around = [String](); AXu.walk(up, max: 400) { e in let r = AXu.role(e); if r != "AXGroup", r != "AXStaticText" || AXu.text(e).count < 60, around.count < 80 { around.append("\(r): \(String(AXu.text(e).prefix(80)))") } }
            info["composerArea"] = around
        }
        if let m = menuState(app) { info["menu"] = ["options": m.options.map { ["name": $0.name, "selected": $0.selected] }, "power": m.power.map { "\($0.label) \($0.index)/\($0.count)" } ?? ""] }
        return info
    }
    struct Option { var element: AXUIElement; var name: String; var selected: Bool }
    func menuState(_ app: AXUIElement) -> (options: [Option], power: Power?)? {
        var all = [AXUIElement](); AXu.walk(app) { all.append($0) }
        for root in all where ["AXGroup", "AXMenu", "AXPopover"].contains(AXu.role(root)) && ReasoningControl.menuTitles.contains(AXu.norm(AXu.text(root))) {
            var sub = [AXUIElement](); AXu.walk(root, max: 300) { sub.append($0) }
            let power = sub.filter { AXu.role($0) == "AXStaticText" }.compactMap { ReasoningControl.parsePower(AXu.text($0)) }.first
            let opts = sub.compactMap { e -> Option? in
                guard ["AXButton", "AXCheckBox", "AXMenuItem", "AXRadioButton", "AXRow"].contains(AXu.role(e)), AXu.available(e), let n = ReasoningControl.optionName(AXu.text(e)) else { return nil }
                return Option(element: e, name: n, selected: (AXu.get(e, kAXSelectedAttribute) as? Bool) == true || AXu.text(e).contains("✓"))
            }
            if !opts.isEmpty || power != nil { return (opts, power) }
        }
        return nil
    }

    // MARK: control of the open conversation
    enum Outcome { case verified(String), sent(String), refused(String), unsupported(String) }
    private func post(_ code: CGKeyCode) -> Bool {
        guard isFrontmost else { return false }
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] { guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return false }; e.post(tap: .cghidEventTap) }
        return true
    }
    private func trigger(_ app: AXUIElement) -> AXUIElement? {
        var optionPopup = [AXUIElement](), strong = [AXUIElement](), titled = [AXUIElement](), optionAny = [AXUIElement]()
        AXu.walk(app) { e in
            let r = AXu.role(e); guard ["AXButton", "AXMenuButton", "AXPopUpButton"].contains(r), AXu.available(e) else { return }
            let t = AXu.norm(AXu.text(e)), popup = r != "AXButton"
            if ReasoningControl.menuTitles.contains(t) { titled.append(e) }
            if popup, ReasoningControl.triggerWords.contains(where: { t.contains($0) }) { strong.append(e) }
            if ReasoningControl.optionName(t) != nil { optionAny.append(e); if popup { optionPopup.append(e) } }
        }
        if optionPopup.count == 1 { return optionPopup[0] }
        if strong.count == 1 { return strong[0] }
        if titled.count == 1 { return titled[0] }
        return optionAny.count == 1 ? optionAny[0] : nil
    }
    /// Effort currently shown by the open conversation (menu closed: from the trigger label; menu open: from the power slider), nil if the app does not expose it.
    func readEffort() -> (name: String, index: Int?, count: Int?)? {
        guard let app = app else { return nil }
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if let m = menuState(app) { if let p = m.power { return (p.label, p.index, p.count) }; if let o = m.options.first(where: { $0.selected }) { return (o.name, nil, nil) } }
        if let t = trigger(app), let n = ReasoningControl.optionName(AXu.text(t)) { return (n, nil, nil) }
        return nil
    }
    var pickerOpen = false, lastTurn = Date.distantPast
    private var combos = [String: (CGKeyCode, CGEventFlags)]()
    /// Posts one key combo (cached parse). Only while ChatGPT is the front app.
    static func postCombo(_ combo: String) -> Bool {
        let rc = ReasoningControl.shared
        guard rc.isFrontmost else { return false }
        var parsed = rc.combos[combo]
        if parsed == nil {
            var flags = CGEventFlags(), key: CGKeyCode?
            for part in combo.lowercased().split(separator: "+").map(String.init) {
                switch part { case "cmd", "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift); case "alt", "option": flags.insert(.maskAlternate); case "ctrl", "control": flags.insert(.maskControl); default: key = ActionEngine.keyCodes[part] }
            }
            guard let k = key else { return false }; parsed = (k, flags); rc.combos[combo] = parsed
        }
        let src = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] { guard let e = CGEvent(keyboardEventSource: src, virtualKey: parsed!.0, keyDown: down) else { return false }; e.flags = parsed!.1; e.post(tap: .cghidEventTap) }
        return true
    }
    /// Close the picker (Escape) 5 s after the last turn (a knob click confirms earlier); re-armed by every turn so fast rotation never closes and reopens it.
    private func armClose() {
        closeWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let s = self else { return }
            if Date().timeIntervalSince(s.lastTurn) < 4.8 { s.armClose(); return }
            if s.pickerOpen, s.isFrontmost { _ = s.post(53) }
            s.pickerOpen = false
        }
        closeWork = w; DispatchQueue.main.asyncAfter(deadline: .now() + 5.0, execute: w)
    }
    /// Knob click after turning: the level is already applied by each step, so confirming = closing the picker (same as the earlier Python test: Escape on the slider menu).
    func confirm() -> Outcome {
        guard AXIsProcessTrusted() else { return .refused("Accessibility permission required") }
        guard isFrontmost else { return .refused("ChatGPT is not the frontmost app: ignored (no keys sent)") }
        closeWork?.cancel()
        guard pickerOpen else { return .verified("nothing to confirm (picker already closed)") }
        pickerOpen = false
        return post(53) ? .sent("picker closed; the chosen level stays") : .refused("ChatGPT lost focus")
    }
    private var closeWork: DispatchWorkItem?
    private func scheduleClose() {   // leave the app as we found it: close the reasoning menu after the last turn
        closeWork?.cancel()
        let w = DispatchWorkItem { [weak self] in guard let s = self, s.isFrontmost, let a = s.app, s.menuState(a) != nil else { return }; _ = s.post(53) }
        closeWork = w; DispatchQueue.main.asyncAfter(deadline: .now() + 1.4, execute: w)
    }
    /// delta > 0 = more reasoning. Runs on a background queue. Never posts keys unless ChatGPT is frontmost.
    func step(_ delta: Int, shortcuts: (up: String, down: String, open: String)) -> Outcome {
        guard AXIsProcessTrusted() else { return .refused("Accessibility permission required") }
        guard isFrontmost else { return .refused("ChatGPT is not the frontmost app: ignored (no keys sent)") }
        guard let app = app else { return .refused("ChatGPT is not running") }
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        let n = max(1, min(abs(delta), 8)), dir = delta > 0
        // Fast path (official commands through the shortcuts the app was given in its own keymap): no accessibility-tree walk, no sleeps between steps.
        // The model picker / slider is opened once with the official "open model picker" command and kept open while the dial keeps turning
        // (build 26.727+ no longer opens it by itself: github.com/openai/codex/issues/36978), then closed after an idle moment.
        let combo = dir ? shortcuts.up : shortcuts.down
        if !combo.isEmpty {
            var opened = false
            if !pickerOpen, !shortcuts.open.isEmpty { guard ReasoningControl.postCombo(shortcuts.open) else { return .refused("bad open-picker shortcut") }; pickerOpen = true; opened = true; Thread.sleep(forTimeInterval: 0.09) }
            for i in 0..<n { guard isFrontmost, ReasoningControl.postCombo(combo) else { return .refused("ChatGPT lost focus") }; if i < n - 1 { Thread.sleep(forTimeInterval: 0.012) } }
            lastTurn = Date(); armClose()
            return .sent("\(n)× \(dir ? "increase" : "decrease") shortcut sent\(opened ? ", picker opened" : ", picker already open"); the app does not report the level, so it is not read back")
        }
        // 1) Accessibility: reasoning menu with the power slider (previously verified approach)
        var state = menuState(app)
        if state == nil, let t = trigger(app) {
            let role = AXu.role(t)
            _ = AXUIElementPerformAction(t, (role == "AXButton" ? kAXPressAction : "AXShowMenu") as CFString)
            for _ in 0..<8 { Thread.sleep(forTimeInterval: 0.04); if let m = menuState(app) { state = m; break } }
        }
        if let st = state, let before = st.power {
            var focused = false
            let sys = AXUIElementCreateSystemWide()
            for _ in 0..<12 { if let f = AXu.get(sys, kAXFocusedUIElementAttribute), ["power", "파워"].contains(AXu.norm(AXu.text(f as! AXUIElement))) { focused = true; break }; if !post(125) { return .refused("ChatGPT lost focus") }; Thread.sleep(forTimeInterval: 0.04) }
            guard focused else { return .refused("power slider could not be focused") }
            for _ in 0..<n { if !post(dir ? 124 : 123) { return .refused("ChatGPT lost focus") }; Thread.sleep(forTimeInterval: 0.07) }
            Thread.sleep(forTimeInterval: 0.08); scheduleClose()
            guard let after = menuState(app)?.power else { return .sent("keys sent; state could not be read back") }
            if after.index == before.index { return .verified("at limit: \(after.label) (\(after.index)/\(after.count))") }
            return .verified("\(after.label) (\(after.index)/\(after.count))")
        }
        return .unsupported("no reasoning menu found in the accessibility tree and no ChatGPT shortcut assigned (see Services → GPT Mode)")
    }
}
