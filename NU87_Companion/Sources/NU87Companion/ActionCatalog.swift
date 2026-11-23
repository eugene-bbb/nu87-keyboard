import Foundation

/// The firmware's ACTIONS[] table (id, name, short name) mirrored for the web editor. IDs are the firmware's; do not renumber.
/// Execution stays in ActionEngine/Config; this only describes actions to the editor and validates custom slots.
enum ActionCatalog {
    static let rows: [(id: Int, name: String)] = [
        (1, "Claude"), (2, "Codex"), (3, "AI Accept"), (4, "AI Stop"), (54, "Reasoning Up"), (55, "Reasoning Down"), (56, "Reasoning Menu"),
        (10, "Copy"), (11, "Paste"), (12, "Undo"), (13, "Screenshot"), (57, "Scroll Down"), (58, "Scroll Up"),
        (20, "Play / Pause"), (21, "Next Track"), (22, "Previous Track"), (23, "Mute"), (50, "Volume Up"), (51, "Volume Down"),
        (30, "Next Profile"), (31, "Key Mapping"), (52, "Brightness Up"), (53, "Brightness Down"), (60, "Next Knob Mode"),
        (40, "Usagi React"), (41, "Lunch Pick"), (61, "GPT Mode"), (63, "AI Activity"), (70, "Custom 1"), (71, "Custom 2"), (72, "Custom 3"), (73, "Custom 4"), (0, "None")]
    static let customIDs = [70, 71, 72, 73]
    static let deviceLocal: Set<Int> = [0, 30, 31, 40, 41, 56, 60, 61, 63]   // handled on the board, never sent to the Mac (firmware isPcAction)

    static func keyLabel(_ k: String) -> String {
        k.lowercased().split(separator: "+").map { p -> String in
            switch p { case "cmd", "command": return "⌘"; case "shift": return "⇧"; case "alt", "option": return "⌥"; case "ctrl", "control": return "⌃"; default: return p.uppercased() } }.joined()
    }

    static func describe() -> [[String: Any]] {
        let cfg = Config.load()
        return rows.map { r in
            let def = cfg.actions[String(r.id)]
            let local = deviceLocal.contains(r.id), custom = customIDs.contains(r.id)
            var type = def?.type ?? "unsupported"; if local { type = "device" }
            let supported = local || (type != "unsupported")
            var cat: String
            switch r.id {
            case 0: cat = "None"
            case 1, 2, 3, 4, 54, 55, 56: cat = "AI"
            case 10, 11, 12, 13: cat = "Shortcut"
            case 20, 21, 22, 23, 50, 51: cat = "Media"
            case 52, 53, 57, 58: cat = "System"
            case 30, 31, 40, 41, 60, 61, 63: cat = "Device"
            default: cat = type == "app" ? "Apps" : "Custom"
            }
            var detail = ""
            if local { detail = "Runs on the NU87" }
            else if !supported { detail = custom ? "Not assigned" : "No verified Mac interface" }
            else if type == "app" { detail = def?.url != nil ? "Opens \(def?.label ?? "") (ChatGPT app)" : "Opens \(def?.app ?? "")" } else if type == "url" { detail = def?.url ?? "" }
            else if type == "keys" { detail = keyLabel(def?.keys ?? "") } else { detail = "Mac system action" }
            var o: [String: Any] = ["id": r.id, "name": custom && supported ? (def?.label ?? r.name) : r.name, "category": cat, "runsOn": local ? "device" : "mac",
                                    "supported": supported, "custom": custom, "detail": detail]
            if custom { o["def"] = ["type": supported ? type : "none", "value": type == "app" ? (def?.app ?? "") : type == "url" ? (def?.url ?? "") : type == "keys" ? (def?.keys ?? "") : "", "label": def?.label ?? r.name] }
            return o
        }
    }

    static func validCombo(_ v: String) -> Bool {
        let parts = v.lowercased().split(separator: "+").map(String.init), mods: Set<String> = ["cmd", "command", "shift", "alt", "option", "ctrl", "control"]
        let keys = parts.filter { !mods.contains($0) }
        return keys.count == 1 && ActionEngine.keyCodes[keys[0]] != nil && parts.count - keys.count >= 1
    }
    /// Optional ChatGPT shortcuts (set by the user in ChatGPT > Settings > Keyboard shortcuts) for Reasoning Up/Down.
    static func setSessionKeys(up: String, down: String, open: String = "") -> String? {
        for v in [up, down, open] where !v.isEmpty && !validCombo(v) { return "key combo needs a modifier and a known key, e.g. ctrl+alt+up" }
        var cfg = Config.load()
        for (k, v) in [("54", up), ("55", down), ("56", open)] { if var d = cfg.actions[k] { d.keys = v.isEmpty ? nil : v.lowercased(); cfg.actions[k] = d } }
        Config.save(cfg); return nil
    }
    /// PUT /api/custom/<70-73>. Only app / url / key-combo (no shell). Returns an error text or nil.
    static func setCustom(id: Int, type: String, value: String, label: String) -> String? {
        guard customIDs.contains(id) else { return "only Custom 1-4 (70-73) can be edited" }
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines), l = String(label.trimmingCharacters(in: .whitespacesAndNewlines).prefix(24))
        var cfg = Config.load(); let key = String(id), name = l.isEmpty ? "Custom \(id - 69)" : l
        switch type {
        case "none": cfg.actions[key] = ActionDef(type: "unsupported", label: "Custom \(id - 69)")
        case "app":
            guard !v.isEmpty, v.count <= 64, !v.contains("/"), !v.contains("\\") else { return "invalid app name" }
            guard ActionEngine.appURL(v) != nil else { return "app '\(v)' was not found in /Applications" }
            cfg.actions[key] = ActionDef(type: "app", label: name, app: v)
        case "url":
            guard v.count <= 512, let u = URL(string: v), let s = u.scheme?.lowercased(), ["http", "https", "mailto"].contains(s) else { return "URL must be http, https or mailto" }
            cfg.actions[key] = ActionDef(type: "url", label: name, url: v)
        case "keys":
            let parts = v.lowercased().split(separator: "+").map(String.init)
            let mods: Set<String> = ["cmd", "command", "shift", "alt", "option", "ctrl", "control"]
            let keys = parts.filter { !mods.contains($0) }
            guard keys.count == 1, ActionEngine.keyCodes[keys[0]] != nil, parts.count - keys.count >= 1 else { return "key combo needs at least one modifier and one known key, e.g. cmd+shift+4" }
            cfg.actions[key] = ActionDef(type: "keys", label: name, keys: v.lowercased())
        default: return "unknown type"
        }
        Config.save(cfg); return nil
    }
}
