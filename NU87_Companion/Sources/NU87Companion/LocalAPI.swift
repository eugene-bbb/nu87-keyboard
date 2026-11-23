import Foundation
import Network

/// Local settings bridge for the web editor: 127.0.0.1 only, Host/Origin checked, writes need an allowed Origin plus X-NU87 header (forces a CORS preflight).
/// It also serves the built editor (nu87-editor/dist) so http://127.0.0.1:17871/ works without a dev server.
final class LocalAPI {
    static let port: UInt16 = 17871
    struct Req { var method: String; var path: String; var headers: [String: String]; var body: Data }
    struct Res { var status: Int; var body: Data; var type = "application/json"
        static func json(_ o: Any, _ s: Int = 200) -> Res { Res(status: s, body: (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{}".utf8)) }
        static func err(_ s: Int, _ m: String, extra: [String: Any] = [:]) -> Res { json(["ok": false, "error": m].merging(extra) { a, _ in a }, s) } }

    var sync: DeviceSync!, ble: BLEClient!, hub: NotifyHub!, gmail: GmailClient!, lunch: LunchService!, ai: AIHub!, time: TimeSync!, weather: WeatherService!
    var session = 0                       // bumped on every (re)connect so the web re-reads the device
    private var listener: NWListener?
    static let allowedOrigins: Set<String> = ["http://127.0.0.1:\(port)", "http://localhost:\(port)", "http://127.0.0.1:5200", "http://localhost:5200"]
    static let allowedHosts: Set<String> = ["127.0.0.1:\(port)", "localhost:\(port)"]

    func start() {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: LocalAPI.port)!)
        do { listener = try NWListener(using: params) } catch { Log.shared.write("local API: cannot listen: \(error)"); return }
        listener?.newConnectionHandler = { [weak self] c in self?.accept(c) }
        listener?.stateUpdateHandler = { st in Log.shared.write("local API \(st) on 127.0.0.1:\(LocalAPI.port)") }
        listener?.start(queue: .main)
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: .main)
        var buf = Data()
        func more() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
                guard let self = self else { return c.cancel() }
                if let d = data { buf.append(d) }
                if buf.count > 200_000 { return self.reply(c, .err(413, "too large"), nil) }
                if let r = Self.parse(buf) { return self.route(r, c) }
                if done || err != nil { c.cancel() } else { more() }
            }
        }
        more()
    }
    static func parse(_ d: Data) -> Req? {
        guard let sep = d.range(of: Data("\r\n\r\n".utf8)), let head = String(data: d[..<sep.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n"); let first = lines[0].split(separator: " ")
        guard first.count >= 2 else { return nil }
        var h = [String: String](); for l in lines.dropFirst() { if let i = l.firstIndex(of: ":") { h[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
        let need = Int(h["content-length"] ?? "0") ?? 0, body = d[sep.upperBound...]
        if body.count < need { return nil }
        return Req(method: String(first[0]), path: String(first[1]), headers: h, body: Data(body.prefix(need)))
    }

    private func reply(_ c: NWConnection, _ r: Res, _ req: Req?) {
        var h = "HTTP/1.1 \(r.status) \(r.status == 200 ? "OK" : "Error")\r\nContent-Type: \(r.type)\r\nContent-Length: \(r.body.count)\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\n"
        if let o = req?.headers["origin"], LocalAPI.allowedOrigins.contains(o) {
            h += "Access-Control-Allow-Origin: \(o)\r\nVary: Origin\r\nAccess-Control-Allow-Headers: content-type, x-nu87\r\nAccess-Control-Allow-Methods: GET, POST, PUT, OPTIONS\r\nAccess-Control-Allow-Private-Network: true\r\n"
        }
        c.send(content: Data(h.utf8) + Data("\r\n".utf8) + r.body, completion: .contentProcessed { _ in c.cancel() })
    }

    private func route(_ r: Req, _ c: NWConnection) {
        func done(_ x: Res) { reply(c, x, r) }
        let path = r.path.split(separator: "?").first.map(String.init) ?? "/"
        guard let host = r.headers["host"], LocalAPI.allowedHosts.contains(host.lowercased()) else { return done(.err(403, "bad Host")) }
        let origin = r.headers["origin"]
        if let o = origin, !LocalAPI.allowedOrigins.contains(o) { return done(.err(403, "origin not allowed")) }
        if r.method == "OPTIONS" { return done(Res(status: 200, body: Data())) }
        let write = r.method != "GET"
        if write && (origin == nil || r.headers["x-nu87"] != "1") { return done(.err(403, "write requires an allowed Origin and X-NU87 header")) }
        if r.method == "GET" && path == "/oauth/callback" {
            var q = [String: String](); URLComponents(string: "http://x" + r.path)?.queryItems?.forEach { q[$0.name] = $0.value ?? "" }
            return gmail.handleCallback(query: q) { html in done(Res(status: 200, body: Data(html.utf8), type: "text/html; charset=utf-8")) }
        }
        if !path.hasPrefix("/api/") { return done(r.method == "GET" ? staticFile(path) : .err(405, "method")) }
        switch (r.method, path) {
        case ("GET", "/api/status"): done(.json(status()))
        case ("GET", "/api/actions"): done(.json(["ok": true, "actions": ActionCatalog.describe()]))
        case ("GET", "/api/config"):
            sync.read { res in
                switch res {
                case .success(let cfg): done(.json(["ok": true, "config": Self.obj(cfg), "rev": cfg.rev]))
                case .failure(let e): done(.err(Self.code(e), e.text))
                }
            }
        case ("POST", "/api/config"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let base = o["baseRev"] as? Int, let cobj = o["config"],
                  let cd = try? JSONSerialization.data(withJSONObject: cobj), let cfg = try? JSONDecoder().decode(DeviceConfig.self, from: cd) else { return done(.err(400, "bad body (need baseRev + config)")) }
            sync.write(cfg, baseRev: base) { res in
                switch res {
                case .success(let after): Log.shared.write("web: settings saved to NU87 (rev \(after.rev))"); done(.json(["ok": true, "config": Self.obj(after), "rev": after.rev]))
                case .failure(.conflict(let cur)): done(.err(409, SyncError.conflict(cur).text, extra: ["config": Self.obj(cur), "rev": cur.rev]))
                case .failure(let e): Log.shared.write("web: save failed: \(e.text)"); done(.err(Self.code(e), e.text))
                }
            }
        case ("PUT", _) where path.hasPrefix("/api/custom/"):
            guard let id = Int(path.dropFirst("/api/custom/".count)), let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any],
                  let type = o["type"] as? String else { return done(.err(400, "bad body")) }
            if let e = ActionCatalog.setCustom(id: id, type: type, value: o["value"] as? String ?? "", label: o["label"] as? String ?? "") { return done(.err(400, e)) }
            Log.shared.write("web: custom action \(id) set to \(type)"); done(.json(["ok": true, "actions": ActionCatalog.describe()]))
        case ("POST", "/api/notify"):   // test notification only: always labelled TEST on the bubble
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let title = o["title"] as? String, !title.isEmpty else { return done(.err(400, "title required")) }
            hub.send(.init(kind: "t", prio: 1, title: title, body: o["body"] as? String ?? "")) { res in
                switch res { case .success: done(.json(["ok": true, "shown": true])); case .failure(let e): done(.err(Self.code(e), e.text)) } }
        case ("GET", "/api/gmail"): done(.json(["ok": true, "gmail": gmail.status()]))
        case ("PUT", "/api/gmail"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let en = o["enabled"] as? Bool else { return done(.err(400, "enabled required")) }
            gmail.enabled = en; done(.json(["ok": true, "gmail": gmail.status()]))
        case ("POST", "/api/gmail/client"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let id = o["clientId"] as? String, let sec = o["clientSecret"] as? String, !id.isEmpty, !sec.isEmpty else { return done(.err(400, "clientId and clientSecret required")) }
            gmail.setClient(id: id, secret: sec); done(.json(["ok": true, "gmail": gmail.status()]))
        case ("POST", "/api/gmail/connect"):
            switch gmail.connect() { case .success(let u): done(.json(["ok": true, "url": u])); case .failure(let e): done(.err(400, e.text)) }
        case ("POST", "/api/gmail/disconnect"): gmail.disconnect(); done(.json(["ok": true, "gmail": gmail.status()]))
        case ("POST", "/api/gmail/check"): gmail.check(manual: true) { m in done(.json(["ok": true, "result": m, "gmail": self.gmail.status()])) }
        case ("GET", "/api/lunch"): done(.json(["ok": true, "lunch": lunch.status()]))
        case ("PUT", "/api/lunch"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any] else { return done(.err(400, "bad body")) }
            var s = lunch.settings
            if let v = o["radius"] as? Int, [500, 1000, 2000, 3000].contains(v) { s.radius = v }
            defer { if ble.isReady { lunch.pushSettings() } }
            if let v = o["categories"] as? [String] { s.categories = v.filter { ["한식", "중식", "일식", "양식", "분식", "아시아음식", "패스트푸드", "기타"].contains($0) } }
            if let v = o["excludeRecent"] as? Int { s.excludeRecent = max(0, min(50, v)) }
            if let v = o["useCurrentLocation"] as? Bool { s.useCurrentLocation = v; if v { lunch.location.get { _ in } } }
            if let v = o["mapProvider"] as? String, ["kakao", "naver"].contains(v) { s.mapProvider = v }
            lunch.settings = s; done(.json(["ok": true, "lunch": lunch.status()]))
        case ("POST", "/api/lunch/key"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let k = o["key"] as? String, !k.isEmpty else { return done(.err(400, "key required")) }
            lunch.setKey(k); done(.json(["ok": true, "lunch": lunch.status()]))
        case ("POST", "/api/lunch/workplace"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let q = o["query"] as? String, !q.isEmpty else { return done(.err(400, "query required")) }
            lunch.setWorkplace(query: q) { res in switch res { case .success: done(.json(["ok": true, "lunch": self.lunch.status()])); case .failure(let e): done(.err(400, e.text)) } }
        case ("POST", "/api/lunch/roll"):   // real search from the web (test); the board is not involved
            lunch.roll { res in switch res {
                case .success(let p):
                    let onBoard = self.ble.isReady
                    if onBoard { self.lunch.pushPlace(p); self.hub.send(.init(kind: "l", prio: 1, title: p.name, body: "\(p.category) · \(p.distance)m")) { _ in } }   // result also shown on the keyboard (Lunch screen + bubble)
                    done(.json(["ok": true, "place": LunchService.json(p), "sentToBoard": onBoard]))
                case .failure(let e): done(.err(e.code == 3 ? 400 : 502, e.text)) } }
        case ("PUT", "/api/gpt/keys"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any] else { return done(.err(400, "bad body")) }
            if let e = ActionCatalog.setSessionKeys(up: o["up"] as? String ?? "", down: o["down"] as? String ?? "") { return done(.err(400, e)) }
            done(.json(["ok": true, "gpt": GPTMode.describe()]))
        case ("POST", "/api/reasoning/inspect"): DispatchQueue.global().async { let i = ReasoningControl.shared.inspect(); DispatchQueue.main.async { done(.json(["ok": true, "info": i])) } }
        case ("POST", "/api/reasoning/step"):   // test aid: same code path as the knob (needs ChatGPT in front)
            let d = ((try? JSONSerialization.jsonObject(with: r.body) as? [String: Any])?["delta"] as? Int) ?? 1
            DispatchQueue.global().async { let res = ActionEngine.execute(id: d > 0 ? 54 : 55, count: abs(d)); DispatchQueue.main.async { done(.json(["ok": res.ackCode == "OK", "result": res.text])) } }
        case ("POST", "/api/gpt/setup-shortcuts"):
            switch GPTMode.installShortcuts() { case .success(let p): done(.json(["ok": true, "file": p, "gpt": GPTMode.describe()])); case .failure(let e): done(.err(400, e.text)) }
        case ("POST", "/api/ai-event"):   // from the official hooks only
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let p = o["provider"] as? String, let e = o["event"] as? String else { return done(.err(400, "bad body")) }
            if let err = ai.event(provider: p, session: o["session"] as? String ?? "", turn: o["turn"] as? String ?? "", event: e, ts: (o["ts"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000,
                                  prompt: o["prompt"] as? String, reply: o["reply"] as? String, keys: o["keys"] as? [String] ?? []) { done(.err(400, err)) } else { done(.json(["ok": true])) }
        case ("POST", "/api/ai-usage"):   // from the Claude Code statusline script (official statusline JSON numbers)
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any] else { return done(.err(400, "bad body")) }
            UsageStore.shared.setClaude(o); ai.pushUsage(); done(.json(["ok": true]))
        case ("GET", "/api/ai"): done(.json(["ok": true, "ai": ai.status()]))
        case ("PUT", "/api/ai/mode"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let m = o["mode"] as? String, ["off", "title", "full"].contains(m) else { return done(.err(400, "mode must be off, title or full")) }
            ai.mode = m; done(.json(["ok": true, "ai": ai.status()]))
        case ("POST", "/api/ai/refresh"): AIHooks.refreshTrust(); AIHooks.refreshCodexUsage(); done(.json(["ok": true]))
        case ("POST", "/api/ai/setup"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let p = o["provider"] as? String, ["claude", "codex", "claude-statusline"].contains(p) else { return done(.err(400, "provider must be claude, codex or claude-statusline")) }
            let res = p == "claude-statusline" ? AIHooks.installStatusline() : AIHooks.install(provider: p)
            switch res { case .success(let f): AIHooks.refreshTrust(); done(.json(["ok": true, "file": f, "ai": ai.status()])); case .failure(let e): done(.err(400, e.text)) }
        case ("GET", "/api/time"): done(.json(["ok": true, "time": time.status()]))
        case ("POST", "/api/time/sync"): time.send("web"); done(.json(["ok": true, "queued": ble.isReady]))
        case ("GET", "/api/weather"): done(.json(["ok": true, "weather": weather.status()]))
        case ("PUT", "/api/weather"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let m = o["mode"] as? String, ["auto", "custom"].contains(m) else { return done(.err(400, "mode must be auto or custom")) }
            var s = weather.settings; s.mode = m; weather.settings = s; if m == "auto" { weather.location.get { _ in } }   // asks for macOS location permission the first time
            weather.refresh(force: true) { done(.json(["ok": true, "weather": self.weather.status()])) }
        case ("POST", "/api/weather/search"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let q = o["query"] as? String, !q.isEmpty else { return done(.err(400, "query required")) }
            weather.search(q) { res, err in if let r = res { done(.json(["ok": true, "results": r])) } else { done(.err(502, err ?? "search failed")) } }
        case ("POST", "/api/weather/select"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let id = o["id"] as? Int, weather.select(id) else { return done(.err(400, "unknown result; search again")) }
            weather.refresh(force: true) { done(.json(["ok": true, "weather": self.weather.status()])) }
        case ("POST", "/api/weather/refresh"): weather.refresh(force: true) { done(.json(["ok": true, "weather": self.weather.status()])) }
        case ("GET", "/api/gpt"): done(.json(["ok": true, "gpt": GPTMode.describe()]))
        case ("POST", "/api/gpt/apply"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let m = o["model"] as? String, let e = o["effort"] as? String else { return done(.err(400, "model and effort required")) }
            switch GPTMode.apply(model: m, effort: e) { case .success: done(.json(["ok": true, "gpt": GPTMode.describe()])); case .failure(let er): done(.err(400, er.text)) }
        default: done(.err(404, "no such endpoint"))
        }
    }
    static func code(_ e: SyncError) -> Int { switch e { case .notConnected: return 503; case .busy: return 423; case .timeout: return 504; case .conflict: return 409; case .invalid: return 400; default: return 502 } }
    static func obj(_ c: DeviceConfig) -> Any {
        guard let d = try? JSONEncoder().encode(c), let o = try? JSONSerialization.jsonObject(with: d) else { return [:] }; return o
    }
    func status() -> [String: Any] {
        ["ok": true, "bridge": "NU87 Companion", "connected": ble.isReady, "confirmed": ble.isConfirmed, "device": ble.deviceLabel, "deviceId": ble.deviceIDPrefix,
         "accessibility": ActionEngine.accessibilityTrusted, "changeSeq": sync.changeSeq, "session": session, "busy": sync.busy]
    }

    // MARK: static web UI (read-only, confined to nu87-editor/dist)
    static var distDir: URL? = {
        var u = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
        for _ in 0..<7 { let d = u.appendingPathComponent("nu87-editor/dist"); if FileManager.default.fileExists(atPath: d.path) { return d }; u.deleteLastPathComponent() }
        return nil
    }()
    func staticFile(_ path: String) -> Res {
        guard let root = Self.distDir?.standardizedFileURL else { return Res(status: 404, body: Data("nu87-editor/dist not built (run npm run build in nu87-editor)".utf8), type: "text/plain") }
        let rel = path == "/" ? "index.html" : String(path.dropFirst()).removingPercentEncoding ?? ""
        let f = root.appendingPathComponent(rel).standardizedFileURL
        guard f.path.hasPrefix(root.path + "/"), let d = try? Data(contentsOf: f) else { return Res(status: 404, body: Data("not found".utf8), type: "text/plain") }
        let t = ["html": "text/html; charset=utf-8", "js": "text/javascript", "css": "text/css", "svg": "image/svg+xml", "woff2": "font/woff2", "png": "image/png", "json": "application/json"][f.pathExtension] ?? "application/octet-stream"
        return Res(status: 200, body: d, type: t)
    }
}
