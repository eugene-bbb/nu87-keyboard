import AppKit
import ApplicationServices
import CoreAudio
import AudioToolbox

enum ActionResult {
    case ok(String), unsupported(String), failed(String)
    var ackCode: String { switch self { case .ok: return "OK"; case .unsupported: return "UNSUP"; case .failed: return "FAIL" } }
    var text: String { switch self { case .ok(let s): return "OK \(s)"; case .unsupported(let s): return "UNSUPPORTED \(s)"; case .failed(let s): return "FAILED \(s)" } }
}

/// Executes an action ID. Knows nothing about BLE, so a future web editor / other transport can reuse it.
enum ActionEngine {
    static var accessibilityTrusted: Bool { AXIsProcessTrusted() }
    static func promptAccessibility() { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }

    /// `count` = merged knob detents; repeatable actions (keys, media, scroll, brightness) apply it, apps/URLs run once.
    static func execute(id: Int, count: Int = 1) -> ActionResult {
        guard let def = Config.load().actions[String(id)] else { return .unsupported("no mapping for action \(id)") }
        switch def.type {
        case "app":  return openApp(def.app ?? "", deepLink: def.url, label: def.label)
        case "url":  return openURL(def.url ?? "")
        case "keys": return pressKeys(def.keys ?? "", label: def.label, count: count)
        case "media": return mediaKey(def.media ?? "", label: def.label, count: count)
        case "system": return brightness(def.media ?? "", label: def.label, count: count)
        case "gptconfirm":
            switch ReasoningControl.shared.confirm() { case .verified(let t), .sent(let t): return .ok("reasoning confirmed: \(t)"); case .refused(let t): return .failed(t); case .unsupported(let t): return .unsupported(t) }
        case "gpt":
            // Controls the OPEN conversation of the frontmost ChatGPT/Codex app. Never edits ~/.codex/config.toml (that is a separate, explicit web action).
            let cfgNow = Config.load().actions; let sc = (cfgNow["54"]?.keys ?? "", cfgNow["55"]?.keys ?? "", cfgNow["56"]?.keys ?? "")
            switch ReasoningControl.shared.step((def.media == "up" ? 1 : -1) * count, shortcuts: sc) {
            case .verified(let t): return .ok("reasoning \(t) (verified in the app)")
            case .sent(let t): return .ok("UNVERIFIED: \(t)")
            case .refused(let t): return .failed(t)
            case .unsupported(let t): return .unsupported(t)
            }
        case "scroll": return scroll(def.media ?? "down", label: def.label, count: count)
        default: return .unsupported("\(def.label): no verified Mac interface (not simulated)")
        }
    }

    // MARK: apps / URLs
    static func appURL(_ name: String) -> URL? {
        if name.contains("."), let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return u }
        for dir in ["/Applications", "/System/Applications", NSHomeDirectory() + "/Applications"] {
            let p = "\(dir)/\(name).app"; if FileManager.default.fileExists(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }
    /// Bundle-ID names (contain a dot) are resolved through NSWorkspace, so renaming the .app does not break the action.
    /// With a deep link the app is asked to open that URL; if that fails the app is still launched and the result says so (never claims the screen opened).
    static func openApp(_ name: String, deepLink: String? = nil, label: String = "") -> ActionResult {
        guard let url = appURL(name) else { return .failed("app '\(name)' not found") }
        let shown = (try? url.resourceValues(forKeys: [.localizedNameKey]).localizedName) ?? url.deletingPathExtension().lastPathComponent
        let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
        let sem = DispatchSemaphore(value: 0); var err: Error?
        if let dl = deepLink, let u = URL(string: dl), u.scheme == "codex" || u.scheme == "claude" {
            NSWorkspace.shared.open([u], withApplicationAt: url, configuration: cfg) { _, e in err = e; sem.signal() }
            if sem.wait(timeout: .now() + 6) == .timedOut { return .failed("opening \(dl) in \(shown) timed out") }
            if err == nil { return .ok("opened \(dl) in \(shown)") }
            err = nil
        }
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { _, e in err = e; sem.signal() }
        if sem.wait(timeout: .now() + 5) == .timedOut { return .failed("launching '\(name)' timed out") }
        if let e = err { return .failed("\(shown): \(e.localizedDescription)") }
        return .ok(deepLink == nil ? "activated \(shown)" : "launched \(shown) only (deep link not accepted)")
    }
    static func openURL(_ s: String) -> ActionResult {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme != "file", scheme != "javascript" else { return .failed("bad or blocked URL '\(s)'") }
        return NSWorkspace.shared.open(u) ? .ok("opened \(s)") : .failed("could not open \(s)")
    }

    // MARK: keyboard shortcuts (needs Accessibility)
    static let keyCodes: [String: CGKeyCode] = [
        "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,
        "1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,
        "return":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"`":50,"delete":51,"esc":53,
        "left":123,"right":124,"down":125,"up":126]
    static func pressKeys(_ combo: String, label: String, count: Int = 1) -> ActionResult {
        guard accessibilityTrusted else { return .failed("Accessibility permission required for \(label)") }
        var flags = CGEventFlags(); var key: CGKeyCode?
        for part in combo.lowercased().split(separator: "+").map(String.init) {
            switch part { case "cmd", "command": flags.insert(.maskCommand); case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate); case "ctrl", "control": flags.insert(.maskControl)
            default: key = keyCodes[part] }
        }
        guard let k = key else { return .failed("unknown key combo '\(combo)'") }
        let src = CGEventSource(stateID: .hidSystemState)
        for _ in 0..<min(count, 10) { for down in [true, false] {
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: down) else { return .failed("could not create key event") }
            e.flags = flags; e.post(tap: .cghidEventTap)
        } }
        return .ok("\(label) (\(combo))")
    }

    // MARK: media / system keys (system-defined HID events: the same path as the keyboard's own media keys)
    static let mediaCodes: [String: Int32] = ["volup": 0, "voldown": 1, "brightup": 2, "brightdown": 3, "mute": 7, "playpause": 16, "next": 17, "previous": 18]
    static func postSystemKey(_ code: Int32) -> Bool {
        for down in [true, false] {
            let data1 = Int((code << 16) | ((down ? 0xA : 0xB) << 8))
            guard let e = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00),
                                             timestamp: 0, windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)?.cgEvent else { return false }
            e.post(tap: .cghidEventTap)
        }
        return true
    }
    static func mediaKey(_ name: String, label: String, count: Int = 1) -> ActionResult {
        guard accessibilityTrusted else { return .failed("Accessibility permission required for \(label)") }
        guard let code = mediaCodes[name] else { return .failed("unknown media key '\(name)'") }
        let before = (name == "volup" || name == "voldown") ? outputVolume() : nil
        let muteBefore = name == "mute" ? outputMuted() : nil
        let n = (name == "mute" || name == "playpause") ? 1 : min(count, 16)
        for _ in 0..<n { guard postSystemKey(code) else { return .failed("could not create media event") } }
        // Verify volume/mute really changed (CoreAudio); play/next/previous have no readable result.
        if let b = before {
            usleep(90_000)
            if let a = outputVolume(), abs(a - b) < 0.001, !(name == "volup" && b > 0.99), !(name == "voldown" && b < 0.01) { return .failed("\(label): volume did not change (\(Int(b * 100))%)") }
            return .ok("\(label) \(Int(b * 100))% → \(Int((outputVolume() ?? b) * 100))%")
        }
        if let m = muteBefore {
            usleep(90_000)
            if let a = outputMuted(), a == m { return .failed("\(label): mute state did not change") }
            return .ok("\(label) (muted: \(outputMuted().map { $0 ? "yes" : "no" } ?? "?"))")
        }
        return .ok("\(label) (\(name))")
    }

    // MARK: brightness: only the displays the system brightness keys can reach
    static func brightness(_ name: String, label: String, count: Int) -> ActionResult {
        guard accessibilityTrusted else { return .failed("Accessibility permission required for \(label)") }
        var ids = [CGDirectDisplayID](repeating: 0, count: 16); var n: UInt32 = 0
        CGGetActiveDisplayList(16, &ids, &n)
        let active = ids.prefix(Int(n))
        let supported = active.filter { CGDisplayIsBuiltin($0) != 0 || CGDisplayVendorNumber($0) == 0x0610 }   // built-in or Apple display
        guard !supported.isEmpty else { return .unsupported("\(label): only external non-Apple displays found (DDC/CI brightness is not implemented)") }
        guard let code = mediaCodes[name] else { return .failed("unknown key '\(name)'") }
        for _ in 0..<min(count, 16) { guard postSystemKey(code) else { return .failed("could not create brightness event") } }
        let external = active.count - supported.count
        return .ok("\(label) ×\(min(count, 16)) on built-in/Apple display" + (external > 0 ? " (\(external) external display(s) not controlled)" : ""))
    }

    // MARK: scroll wheel at the current pointer position
    static func scroll(_ dir: String, label: String, count: Int) -> ActionResult {
        guard accessibilityTrusted else { return .failed("Accessibility permission required for \(label)") }
        let lines = Int32(min(count, 10) * 3) * (dir == "up" ? 1 : -1)   // positive wheel delta scrolls up
        guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0) else { return .failed("could not create scroll event") }
        e.post(tap: .cghidEventTap)
        return .ok("\(label) (\(abs(lines)) lines)")
    }

    // MARK: CoreAudio read-back for verification
    static func defaultOutputDevice() -> AudioDeviceID? {
        var dev = AudioDeviceID(0); var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var a = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &a, 0, nil, &size, &dev) == noErr ? dev : nil
    }
    static func outputVolume() -> Float? {
        guard let d = defaultOutputDevice() else { return nil }
        var v = Float32(0); var size = UInt32(MemoryLayout<Float32>.size)
        var a = AudioObjectPropertyAddress(mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(d, &a, 0, nil, &size, &v) == noErr ? v : nil
    }
    static func outputMuted() -> Bool? {
        guard let d = defaultOutputDevice() else { return nil }
        var m = UInt32(0); var size = UInt32(MemoryLayout<UInt32>.size)
        var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectGetPropertyData(d, &a, 0, nil, &size, &m) == noErr ? m != 0 : nil
    }
}
