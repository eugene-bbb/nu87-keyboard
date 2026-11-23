import Foundation

/// GPT Mode = model + reasoning effort of the Codex configuration (~/.codex/config.toml, the official config file shared by the Codex CLI and the
/// Codex part of the ChatGPT app). The model list and each model's supported effort levels come from ~/.codex/models_cache.json written by Codex itself.
/// Applying edits only the two top-level keys, keeps a backup, and re-reads the file to verify. It changes NEW Codex sessions; it does not touch a thread that is already open.
enum GPTMode {
    static let efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]
    struct Model { var slug: String, name: String, efforts: [String] }
    static var dir: URL { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".codex") }
    static var configURL: URL { dir.appendingPathComponent("config.toml") }

    static func models() -> [Model] {
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("models_cache.json")),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let ms = j["models"] as? [[String: Any]] else { return [] }
        return ms.compactMap { m in
            guard (m["visibility"] as? String) == "list", let slug = m["slug"] as? String else { return nil }
            let lv = (m["supported_reasoning_levels"] as? [[String: Any]])?.compactMap { $0["effort"] as? String }.filter { efforts.contains($0) } ?? []
            return lv.isEmpty ? nil : Model(slug: slug, name: (m["display_name"] as? String) ?? slug, efforts: lv)
        }
    }
    static func current() -> (model: String?, effort: String?) {
        guard let t = try? String(contentsOf: configURL, encoding: .utf8) else { return (nil, nil) }
        var m: String?, e: String?
        for l in t.components(separatedBy: "\n") {
            if l.hasPrefix("[") { break }
            if let v = value(l, key: "model") { m = v }
            if let v = value(l, key: "model_reasoning_effort") { e = v }
        }
        return (m, e)
    }
    private static func value(_ line: String, key: String) -> String? {
        let p = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard p.count == 2, p[0] == key else { return nil }
        return p[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"' "))
    }
    static func apply(model: String, effort: String) -> Result<Void, SyncError> {
        let list = models()
        guard let m = list.first(where: { $0.slug == model }), m.efforts.contains(effort) else { return .failure(.invalid("model/effort not in the verified Codex list")) }
        guard let old = try? String(contentsOf: configURL, encoding: .utf8) else { return .failure(.device("~/.codex/config.toml not found")) }
        var lines = old.components(separatedBy: "\n"), firstTable = lines.firstIndex { $0.hasPrefix("[") } ?? lines.count
        func set(_ key: String, _ v: String) {
            if let i = lines[..<firstTable].firstIndex(where: { value($0, key: key) != nil }) { lines[i] = "\(key) = \"\(v)\"" }
            else { lines.insert("\(key) = \"\(v)\"", at: 0); firstTable += 1 }
        }
        set("model", model); set("model_reasoning_effort", effort)
        try? old.write(to: dir.appendingPathComponent("config.toml.nu87-backup"), atomically: true, encoding: .utf8)
        do { try lines.joined(separator: "\n").write(to: configURL, atomically: true, encoding: .utf8) } catch { return .failure(.device("could not write config.toml: \(error.localizedDescription)")) }
        let c = current()
        return c.model == model && c.effort == effort ? .success(()) : .failure(.verify("config.toml did not contain the new values after writing"))
    }
    /// Reasoning Up/Down key action: next/previous effort the current model supports (never beyond the verified list).
    static func step(_ d: Int) -> ActionResult {
        let c = current()
        guard let slug = c.model, let m = models().first(where: { $0.slug == slug }) else { return .unsupported("current Codex model is not in the verified list") }
        let order = efforts.filter { m.efforts.contains($0) }
        guard let i = order.firstIndex(of: c.effort ?? "medium") ?? order.firstIndex(of: "medium") else { return .unsupported("no reasoning levels") }
        let n = i + d
        guard order.indices.contains(n) else { return .ok("reasoning already at \(order[i]) (limit)") }
        switch apply(model: slug, effort: order[n]) { case .success: return .ok("Codex reasoning → \(order[n]) (new sessions)"); case .failure(let e): return .failed(e.text) }
    }
    /// Writes the app's own user keymap (~/.codex/keybindings.json: [{command, key}]) for the official commands "Increase/Decrease reasoning effort"
    /// and points the knob at the same key combos. Existing entries are kept and the old file is backed up. ChatGPT must be restarted once to load it.
    static func installShortcuts() -> Result<String, SyncError> {
        let url = dir.appendingPathComponent("keybindings.json"), cmds = ["composer.increaseReasoningEffort": "Ctrl+Alt+Command+Up", "composer.decreaseReasoningEffort": "Ctrl+Alt+Command+Down", "composer.openModelPicker": "Ctrl+Alt+Command+M"]
        var arr = [[String: Any]]()
        if let d = try? Data(contentsOf: url), !d.isEmpty {
            guard let a = try? JSONSerialization.jsonObject(with: d) as? [[String: Any]] else { return .failure(.invalid("existing keybindings.json is not in the expected format; left untouched")) }
            arr = a; try? d.write(to: dir.appendingPathComponent("keybindings.json.nu87-backup"))
        }
        arr.removeAll { cmds.keys.contains($0["command"] as? String ?? "") }
        for (c, k) in cmds { arr.append(["command": c, "key": k]) }
        guard let out = try? JSONSerialization.data(withJSONObject: arr, options: [.prettyPrinted]), (try? out.write(to: url, options: .atomic)) != nil else { return .failure(.device("could not write keybindings.json")) }
        _ = ActionCatalog.setSessionKeys(up: "ctrl+alt+cmd+up", down: "ctrl+alt+cmd+down", open: "ctrl+alt+cmd+m")
        return .success(url.path)
    }
    static func effortIndex(_ label: String) -> Int? {
        let n = AXu.norm(label).replacingOccurrences(of: "-", with: " ")
        let map = ["low": 0, "낮음": 0, "medium": 1, "보통": 1, "중간": 1, "high": 2, "높음": 2, "extra high": 3, "xhigh": 3, "매우 높음": 3, "max": 4, "최고": 4, "ultra": 5, "울트라": 5]
        return map[n]
    }
    static func describe() -> [String: Any] {
        let c = current()
        return ["models": models().map { ["slug": $0.slug, "name": $0.name, "efforts": $0.efforts] }, "current": ["model": c.model ?? "", "effort": c.effort ?? ""],
                "source": "~/.codex/models_cache.json + config.toml", "sessionKeys": ["up": Config.load().actions["54"]?.keys ?? "", "down": Config.load().actions["55"]?.keys ?? ""], "applies": "new Codex sessions (the open ChatGPT thread is not changed)"]
    }
}

/// Board side of GPT Mode: answers GPT|REQ with the model list and GPT|SET|m|e by applying + re-pushing the verified state.
final class GPTBridge {
    unowned let ble: BLEClient
    init(ble: BLEClient) { self.ble = ble }
    func handle(_ text: String) -> Bool {
        var any = false
        for l in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) where l.hasPrefix("GPT|") {
            any = true; let f = l.split(separator: "|").map(String.init)
            if f.count >= 2, f[1] == "REQ" { push() }
            else if f.count == 4, f[1] == "SET", let mi = Int(f[2]), let ei = Int(f[3]) { set(mi, ei) }
        }
        return any
    }
    private var list: [GPTMode.Model] { Array(GPTMode.models().prefix(8)) }
    func push() {
        let ms = list, c = GPTMode.current()
        let cur = ms.firstIndex { $0.slug == c.model } ?? 255      // model of the Codex default config: only the initial selection of the Model row
        var eff = 9                                                // effort of the OPEN conversation as read from the app (9 = not readable)
        if let r = ReasoningControl.shared.readEffort(), let i = GPTMode.effortIndex(r.name) { eff = i }
        var lines = [String(format: "GS|%02X|%02X|%d", ms.count, cur, eff)]
        for (i, m) in ms.enumerated() {
            let mask = m.efforts.compactMap { GPTMode.efforts.firstIndex(of: $0) }.reduce(0) { $0 | (1 << $1) }
            lines.append(String(format: "GM|%d|%02X", i, mask))
            let b = Array(NotifyHub.clip(m.name, bytes: 16).utf8); var k = 0
            while k < b.count { lines.append("GN|\(i)|" + b[k..<min(k + 6, b.count)].map { String(format: "%02X", $0) }.joined()); k += 6 }
        }
        lines.append(String(format: "GE|%02X", ms.count))
        ble.sendLines(lines)
    }
    /// LCD Save = change the reasoning of the open ChatGPT conversation. A different model is Unsupported (no verified control) and leaves everything unchanged.
    private func set(_ mi: Int, _ ei: Int) {
        let ms = list
        guard ms.indices.contains(mi), GPTMode.efforts.indices.contains(ei) else { return reply("GA|ERR|1") }
        let c = GPTMode.current()
        if ms[mi].slug != c.model { Log.shared.write("GPT_SET refused: model change is unsupported for the open conversation"); return reply("GA|ERR|3") }
        DispatchQueue.global().async {
            let rc = ReasoningControl.shared
            guard let cur = rc.readEffort(), let ci = GPTMode.effortIndex(cur.name) else { return DispatchQueue.main.async { self.reply(rc.isFrontmost ? "GA|ERR|5" : "GA|ERR|4") } }
            let order = ms[mi].efforts, from = order.firstIndex(of: GPTMode.efforts[ci]), to = order.firstIndex(of: GPTMode.efforts[ei])
            guard let f = from, let t = to else { return DispatchQueue.main.async { self.reply("GA|ERR|5") } }
            if f == t { return DispatchQueue.main.async { self.reply("GA|OK|C") } }
            let o = rc.step(t - f, shortcuts: (Config.load().actions["54"]?.keys ?? "", Config.load().actions["55"]?.keys ?? "", Config.load().actions["56"]?.keys ?? ""))
            DispatchQueue.main.async {
                switch o {
                case .verified: Log.shared.write("REASONING_CHANGE previous=\(GPTMode.efforts[ci]) new=\(GPTMode.efforts[ei]) scope=open_conversation"); self.push(); DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { self.reply("GA|OK|C") }
                case .sent: self.reply("GA|ERR|5")
                case .refused(let m): self.reply(m.contains("frontmost") ? "GA|ERR|4" : "GA|ERR|2")
                case .unsupported: self.reply("GA|ERR|3")
                }
            }
        }
    }
    private func reply(_ l: String) { ble.sendLines([l]) }
}

extension BLEClient {
    /// Fixed-spacing line writer (each <= 20 bytes). Lines of different features may interleave; every feature keys its own state by line prefix.
    func sendLines(_ lines: [String], spacing: Double = 0.04) {
        func step(_ i: Int) { guard i < lines.count, sendLine(lines[i]) else { return }; DispatchQueue.main.asyncAfter(deadline: .now() + spacing) { step(i + 1) } }
        step(0)
    }
}
