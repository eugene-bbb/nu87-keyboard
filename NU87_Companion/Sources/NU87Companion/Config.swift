import Foundation

/// One executable action. type: app | url | keys | media | unsupported.
struct ActionDef: Codable {
    var type: String
    var label: String
    var app: String?     // app name or bundle id
    var url: String?     // http(s) or app URL scheme
    var keys: String?    // e.g. "cmd+shift+4"
    var media: String?   // playpause | next | previous | mute | volup | voldown
}

/// Action IDs are the firmware's ACTIONS[] ids (firmware_impl.h). Edit config.json to repoint any ID;
/// it is re-read on every event. There is intentionally no shell-command action type.
struct Config: Codable {
    var actions: [String: ActionDef]

    static let defaults = Config(actions: [
        "1":  ActionDef(type: "app", label: "Claude", app: "Claude"),
        "2":  ActionDef(type: "app", label: "Codex", app: "com.openai.codex", url: "codex://threads/new"),   // Codex ships inside ChatGPT.app (bundle id com.openai.codex)
        "3":  ActionDef(type: "unsupported", label: "AI Accept"),
        "4":  ActionDef(type: "unsupported", label: "AI Stop"),
        "10": ActionDef(type: "keys", label: "Copy", keys: "cmd+c"),
        "11": ActionDef(type: "keys", label: "Paste", keys: "cmd+v"),
        "12": ActionDef(type: "keys", label: "Undo", keys: "cmd+z"),
        "13": ActionDef(type: "keys", label: "Screenshot", keys: "cmd+shift+4"),
        "20": ActionDef(type: "media", label: "Play / Pause", media: "playpause"),
        "21": ActionDef(type: "media", label: "Next Track", media: "next"),
        "22": ActionDef(type: "media", label: "Previous Track", media: "previous"),
        "23": ActionDef(type: "media", label: "Mute", media: "mute"),
        "50": ActionDef(type: "media", label: "Volume Up", media: "volup"),
        "51": ActionDef(type: "media", label: "Volume Down", media: "voldown"),
        "52": ActionDef(type: "system", label: "Brightness Up", media: "brightup"),
        "53": ActionDef(type: "system", label: "Brightness Down", media: "brightdown"),
        "54": ActionDef(type: "gpt", label: "Reasoning Up", media: "up"),
        "55": ActionDef(type: "gpt", label: "Reasoning Down", media: "down"),
        "56": ActionDef(type: "unsupported", label: "Reasoning Menu"),
        "70": ActionDef(type: "unsupported", label: "Custom 1"),
        "71": ActionDef(type: "unsupported", label: "Custom 2"),
        "72": ActionDef(type: "unsupported", label: "Custom 3"),
        "73": ActionDef(type: "unsupported", label: "Custom 4"),
        "62": ActionDef(type: "gptconfirm", label: "Reasoning Confirm"),
        "57": ActionDef(type: "scroll", label: "Scroll Down", media: "down"),
        "58": ActionDef(type: "scroll", label: "Scroll Up", media: "up"),
    ])

    static var url: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("NU87Companion")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("config.json")
    }

    static func save(_ c: Config) {
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let d = try? enc.encode(c) { try? d.write(to: url, options: .atomic) }
    }

    static func load() -> Config {
        if let data = try? Data(contentsOf: url), var c = try? JSONDecoder().decode(Config.self, from: data) {
            // Migrate only the old untouched default (a separate "Codex" app that no longer exists).
            for k in ["54", "55"] { if let o = c.actions[k], o.type == "unsupported" { c.actions[k] = defaults.actions[k]; save(c) } }   // verified route found: Codex config effort
            if let old = c.actions["2"], old.type == "app", old.app == "Codex", old.url == nil { c.actions["2"] = defaults.actions["2"]; save(c) }
            // Add action IDs introduced by newer firmware without touching the user's existing entries.
            let missing = defaults.actions.filter { c.actions[$0.key] == nil }
            if !missing.isEmpty {
                for (k, v) in missing { c.actions[k] = v }
                let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
                if let d = try? enc.encode(c) { try? d.write(to: url) }
            }
            return c
        }
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        if !FileManager.default.fileExists(atPath: url.path), let d = try? enc.encode(defaults) { try? d.write(to: url) }
        return defaults
    }
}
