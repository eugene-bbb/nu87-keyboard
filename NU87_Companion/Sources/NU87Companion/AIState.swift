import Foundation

/// Text handling for task titles / answer summaries: masked and shortened on the Mac before anything goes to the board. Nothing here is kept in logs.
enum AIText {
    static func mask(_ s: String) -> String {
        var t = s
        for (pat, rep) in [("```[\\s\\S]*?```", " "), ("`[^`]*`", " "), ("https?://\\S+", "링크"), ("[\\w.+-]+@[\\w-]+\\.[\\w.-]+", "메일"), ("(~|/[A-Za-z0-9._-]+)(/[^\\s]*)+", "경로"),
                           ("\\b(sk|pk|ghp|gho|xox[a-z]|AIza|ya29)[-_A-Za-z0-9.]{8,}", "…"), ("\\b[A-Za-z0-9_\\-]{28,}\\b", "…")] {
            t = t.replacingOccurrences(of: pat, with: rep, options: .regularExpression)
        }
        return t.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }
    /// Width in display units (Hangul = 2): the board shows ~22 units per bubble line.
    static func width(_ s: String) -> Int { s.unicodeScalars.reduce(0) { $0 + ($1.value >= 0x1100 ? 2 : 1) } }
    static func clip(_ s: String, units: Int) -> String {
        if width(s) <= units { return s }
        var out = "", w = 0
        for ch in s.unicodeScalars { let c = ch.value >= 0x1100 ? 2 : 1; if w + c > units - 2 { break }; out.unicodeScalars.append(ch); w += c }
        return out.trimmingCharacters(in: .whitespaces) + ".."
    }
    private static func firstSentences(_ s: String, max: Int) -> [String] {
        var parts = [String](); var cur = ""
        for ch in s { cur.append(ch); if ".!?。\n".contains(ch) || (ch == "다" && false) { let t = cur.trimmingCharacters(in: CharacterSet(charactersIn: " \n.!?。-•*#>")); if t.count >= 4 { parts.append(t) }; cur = "" } }
        let t = cur.trimmingCharacters(in: CharacterSet(charactersIn: " \n.!?。-•*#>")); if t.count >= 4 { parts.append(t) }
        return Array(parts.prefix(max))
    }
    /// Short task title from the user's prompt: first sentence, command prefix and markdown stripped, masked, <= 44 units (two lines).
    static func title(from prompt: String) -> String {
        var p = prompt.replacingOccurrences(of: "^\\s*/[\\w:-]+\\s*", with: "", options: .regularExpression)
        p = p.replacingOccurrences(of: "[#*>]+", with: " ", options: .regularExpression)
        guard let first = firstSentences(mask(p), max: 1).first else { return "" }
        return clip(first, units: 44)
    }
    /// 1-2 sentences of the assistant's final answer, only text that is really in it (no generated content).
    static func summary(from reply: String) -> (String, String) {
        let cleaned = mask(reply.replacingOccurrences(of: "\\|[^\\n]*\\|", with: " ", options: .regularExpression).replacingOccurrences(of: "[#*>_]+", with: " ", options: .regularExpression))
        let s = firstSentences(cleaned, max: 2)
        return (s.count > 0 ? clip(s[0], units: 44) : "", s.count > 1 ? clip(s[1], units: 40) : "")
    }
}

/// Real AI work state from official hooks, tracked per provider + session (+ turn) and mirrored to the board as one card per provider.
final class AIHub {
    enum State: String { case working, approval, done, error }
    struct Session { var provider: String; var id: String; var turn: String; var state: State; var at: Date; var hookTs: Double; var title: String; var startedAt: Date }
    struct Last { var line1: String; var line2: String; var ok: Bool; var at: Date }
    unowned let ble: BLEClient
    private(set) var sessions = [String: Session]()
    private var last = [String: Last]()
    private var pushed = [String: String](), pushedText = [String: String](), pushedUsage = [String: String]()
    private var timer: Timer?
    private(set) var fieldKeys = [String: [String]]()          // top-level field NAMES the hooks delivered (diagnostics only, never values)
    static let providers = ["claude", "codex"]
    static let recent: TimeInterval = 8, stale: TimeInterval = 600
    var mode: String { get { UserDefaults.standard.string(forKey: "aiContentMode") ?? "title" } set { UserDefaults.standard.set(newValue, forKey: "aiContentMode"); AIHooks.writeMode(newValue) } }
    init(ble: BLEClient) { self.ble = ble }
    func start() { AIHooks.writeMode(mode); UsageStore.shared.onChange = { [weak self] in self?.pushUsage() }; UsageStore.shared.refreshCodex(force: true); timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() } }

    func event(provider: String, session: String, turn: String, event: String, ts: Double, prompt: String?, reply: String?, keys: [String]) -> String? {
        guard AIHub.providers.contains(provider) else { return "unknown provider" }
        let sid = String(session.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }.prefix(64)), key = provider + "/" + (sid.isEmpty ? "unknown" : sid)
        let tag = "\(provider) \(sid.prefix(8))"
        if !keys.isEmpty { fieldKeys["\(provider)/\(event)"] = keys }
        let old = sessions[key]
        if event == "end" || event == "interrupt" { sessions[key] = nil; Log.shared.write("AI_EVENT \(tag) \(event)"); evaluate(); return nil }
        guard ["start", "working", "approval", "done", "error"].contains(event) else { return "unknown event" }
        if let o = old, ts < o.hookTs { Log.shared.write("AI_EVENT \(tag) \(event) ignored (older than the last event)"); return nil }
        if event != "start", let o = old, !turn.isEmpty, !o.turn.isEmpty, turn != o.turn { Log.shared.write("AI_EVENT \(tag) \(event) ignored (other turn)"); return nil }   // a finished older turn never overwrites a newer one
        var s = old ?? Session(provider: provider, id: sid, turn: turn, state: .working, at: Date(), hookTs: ts, title: "", startedAt: Date())
        s.at = Date(); s.hookTs = ts
        switch event {
        case "start":
            s = Session(provider: provider, id: sid, turn: turn, state: .working, at: Date(), hookTs: ts, title: mode == "off" ? "" : AIText.title(from: prompt ?? ""), startedAt: Date())
        case "working": s.state = .working; if !turn.isEmpty { s.turn = turn }
        case "approval": s.state = .approval
        case "done", "error":
            s.state = event == "done" ? .done : .error
            if provider == "codex" { DispatchQueue.main.asyncAfter(deadline: .now() + 15) { UsageStore.shared.refreshCodex() } }   // a finished turn changed the numbers
            var l1 = "", l2 = ""
            if event == "error" { l1 = "오류 발생"; l2 = s.title }
            else if mode == "full", let r = reply, !r.isEmpty { (l1, l2) = AIText.summary(from: r) }
            if event == "done", l1.isEmpty { l1 = s.title.isEmpty ? "작업 완료!" : s.title; l2 = s.title.isEmpty ? "" : "작업 완료!" }
            last[provider] = Last(line1: l1, line2: l2, ok: event == "done", at: Date())
        default: break
        }
        sessions[key] = s
        Log.shared.write("AI_EVENT \(tag) \(event)")    // no titles, prompts or replies in the log
        evaluate(); return nil
    }

    private struct View { var state: String; var cur: String; var body: String; var key: String }
    private func view(_ p: String, now: Date = Date()) -> View {
        let mine = sessions.values.filter { $0.provider == p }
        if let a = mine.filter({ $0.state == .approval }).max(by: { $0.at < $1.at }) { return View(state: "approval", cur: "", body: a.title, key: "a\(a.at.timeIntervalSince1970)") }
        if let w = mine.filter({ $0.state == .working && now.timeIntervalSince($0.at) < AIHub.stale }).max(by: { $0.startedAt < $1.startedAt }) { return View(state: "thinking", cur: w.title, body: w.title.isEmpty ? "" : "작업 중...", key: "w\(w.id)\(w.turn)") }
        if let f = mine.filter({ ($0.state == .done || $0.state == .error) && now.timeIntervalSince($0.at) < AIHub.recent }).max(by: { $0.at < $1.at }), let l = last[p] {
            return f.state == .done ? View(state: "done", cur: l.line1, body: l.line2, key: "d\(f.at.timeIntervalSince1970)") : View(state: "error", cur: "", body: f.title, key: "e\(f.at.timeIntervalSince1970)")
        }
        return View(state: "idle", cur: "", body: "", key: "i")
    }
    private func evaluate(force: Bool = false) {
        for p in AIHub.providers {
            let v = view(p), l = last[p], tag = p == "claude" ? "c" : "x"
            let textSig = [v.cur, v.body, l?.line1 ?? "", l?.line2 ?? ""].joined(separator: "\u{1}")
            var lines = [String]()
            if force || pushedText[p] != textSig {
                func f(_ k: Int, _ str: String, _ cap: Int) -> [String] { let b = Array(NotifyHub.clip(str, bytes: cap).utf8); var o = [String](), i = 0; while i < b.count { o.append("AF|\(tag)|\(k)|" + b[i..<min(i + 6, b.count)].map { String(format: "%02X", $0) }.joined()); i += 6 }; return o }
                lines = ["AB|\(tag)"] + f(0, v.cur, 60) + f(1, v.body, 40) + f(2, l?.line1 ?? "", 60) + f(3, l?.line2 ?? "", 60) + ["AC|\(tag)"]
            }
            let key = v.state + v.key
            if force || pushed[p] != key { lines.append("AI,\(p),\(v.state)") }
            guard !lines.isEmpty else { continue }
            if ble.isReady { ble.sendLines(lines); pushedText[p] = textSig; if lines.last!.hasPrefix("AI,") { pushed[p] = key; Log.shared.write("AI_STATE \(p) -> \(v.state)") } }
            else { pushed[p] = nil; pushedText[p] = nil }   // board unreachable: nothing is queued; the current state is sent at reconnect
        }
    }
    private func tick() {
        let now = Date()
        for (k, s) in sessions where (s.state == .done || s.state == .error) && now.timeIntervalSince(s.at) > 120 { sessions[k] = nil }
        for (k, s) in sessions where now.timeIntervalSince(s.at) > 6 * 3600 { sessions[k] = nil }   // very old leftovers
        evaluate(); pushUsage(); UsageStore.shared.tick()
    }
    func syncToBoard() { pushed = [:]; pushedText = [:]; pushedUsage = [:]; evaluate(force: true); pushUsage(force: true) }

    // MARK: usage -> board
    func pushUsage(force: Bool = false) {
        guard ble.isReady else { return }
        for p in AIHub.providers {
            let u = UsageStore.shared.snap(p), tag = p == "claude" ? "c" : "x"
            func h(_ v: Int?) -> String { v.map { String(format: "%02X", max(0, min(100, $0))) } ?? "FF" }
            func m(_ v: Int?) -> String { v.map { String(format: "%04X", max(0, min(0xFFFE, $0))) } ?? "FFFF" }
            let ug = "UG|\(tag)|\(h(u.ctx))|\(h(u.h5))|\(h(u.d7))"
            let ut = "UT|\(tag)|\(m(u.h5Min))|\(m(u.d7Min))|\(u.ageMin.map { String(format: "%02X", min($0, 0xFE)) } ?? "FF")|\(u.status)"
            let key = ug + "#\(u.status)#\(u.at.map { Int($0.timeIntervalSince1970) } ?? 0)#\(u.h5Reset.map { Int($0) } ?? 0)#\(u.d7Reset.map { Int($0) } ?? 0)"   // minutes counting down is the board's job: resend only when the data changes
            guard force || pushedUsage[p] != key else { continue }
            ble.sendLines([ug, ut]); pushedUsage[p] = key
        }
    }

    func status() -> [String: Any] {
        let now = Date()
        var ss = sessions.values.sorted { $0.at > $1.at }.map { s -> [String: Any] in
            let stale = s.state == .working && now.timeIntervalSince(s.at) >= AIHub.stale
            return ["provider": s.provider, "session": String(s.id.prefix(8)), "state": stale ? "stale" : s.state.rawValue, "title": mode == "off" ? "" : s.title, "ageSeconds": Int(now.timeIntervalSince(s.at))] }
        ss = Array(ss.prefix(12))
        var lastOut = [String: Any]()
        for (p, l) in last { lastOut[p] = ["line1": mode == "off" ? "" : l.line1, "line2": mode == "off" ? "" : l.line2, "ok": l.ok, "ageSeconds": Int(now.timeIntervalSince(l.at))] }
        return ["sessions": ss, "last": lastOut, "mode": mode, "installed": AIHooks.installed(), "usage": UsageStore.shared.describe(), "fieldsSeen": fieldKeys, "codexHooksTrust": AIHooks.trustCache]
    }
}

/// Usage numbers: Claude from the official statusline JSON (pushed by the statusline script), Codex from the official app-server (account/rateLimits/read).
/// Status codes shared with the board: 0 ok, 1 no data yet, 2 sign-in problem, 3 network / app-server timeout, 4 unsupported, 5 setup needed, 6 stale.
final class UsageStore {
    static let shared = UsageStore()
    struct Claude { var ctx: Int?; var ctxSize: Int?; var h5: Int?; var h5Reset: Double?; var d7: Int?; var d7Reset: Double?; var at: Date }
    struct Codex { var h5: Int?; var h5Reset: Double?; var h5Mins: Int?; var d7: Int?; var d7Reset: Double?; var d7Mins: Int?; var plan: String; var at: Date }
    struct Snap { var ctx: Int? = nil, h5: Int? = nil, d7: Int? = nil, h5Min: Int? = nil, d7Min: Int? = nil, h5Reset: Double? = nil, d7Reset: Double? = nil, ageMin: Int? = nil, status: Int = 0, text: String = "", at: Date? = nil, plan: String = "", h5Win: Int? = nil, d7Win: Int? = nil, ctxSize: Int? = nil }
    var claude: Claude?, codex: Codex?
    var codexErrKind = 0, codexErrText = "", codexAttempt: Date?, codexInFlight = false
    var onChange: (() -> Void)?
    static let contextFresh: TimeInterval = 900, codexInterval: TimeInterval = 600, codexStale: TimeInterval = 1500
    private static var setupCache: (Date, [String: Any])?
    private static func installed() -> [String: Any] {
        if let c = setupCache, Date().timeIntervalSince(c.0) < 30 { return c.1 }
        let v = AIHooks.installed(); setupCache = (Date(), v); return v
    }
    func snap(_ p: String) -> Snap {
        let now = Date(), t = now.timeIntervalSince1970
        func left(_ r: Double?) -> Int? { r.map { max(0, Int(($0 - t) / 60)) } }
        func live(_ v: Int?, _ r: Double?) -> Int? { (r == nil || r! > t) ? v : nil }   // a window that already reset is unknown until new data arrives
        if p == "claude" {
            guard let c = claude else {
                let i = UsageStore.installed()
                if i["otherStatusline"] as? Bool == true { return Snap(status: 5, text: "You use your own Claude statusline; add the usage numbers there or replace it", at: nil, plan: "", h5Win: 300, d7Win: 10080) }
                return (i["claudeStatusline"] as? Bool == true) ? Snap(status: 1, text: "Waiting for the next Claude Code reply", at: nil, plan: "", h5Win: 300, d7Win: 10080)
                                                               : Snap(status: 5, text: "Install the Claude usage statusline", at: nil, plan: "", h5Win: 300, d7Win: 10080)
            }
            let age = now.timeIntervalSince(c.at)
            var s = Snap(ctx: age < UsageStore.contextFresh ? c.ctx : nil, h5: live(c.h5, c.h5Reset), d7: live(c.d7, c.d7Reset), h5Min: left(c.h5Reset), d7Min: left(c.d7Reset), h5Reset: c.h5Reset, d7Reset: c.d7Reset,
                         ageMin: Int(age / 60), status: 0, text: "", at: c.at, plan: "", h5Win: 300, d7Win: 10080, ctxSize: c.ctxSize)
            if s.h5 == nil && s.d7 == nil { s.status = 1; s.text = (c.h5 == nil && c.d7 == nil) ? "Claude Code has not reported rate limits (Pro/Max only, after the first reply)" : "Window reset; waiting for the next Claude Code reply" }
            return s
        }
        guard AIHooks.codexBinary != nil else { return Snap(status: 4, text: "Codex app not found", at: nil, plan: "", h5Win: 300, d7Win: 10080) }
        guard let c = codex else {
            return Snap(status: codexErrKind == 0 ? 1 : codexErrKind, text: codexErrKind == 0 ? "Reading the Codex limits…" : codexErrText, at: nil, plan: "", h5Win: 300, d7Win: 10080)
        }
        let age = now.timeIntervalSince(c.at), stale = age > UsageStore.codexStale
        return Snap(h5: live(c.h5, c.h5Reset), d7: live(c.d7, c.d7Reset), h5Min: left(c.h5Reset), d7Min: left(c.d7Reset), h5Reset: c.h5Reset, d7Reset: c.d7Reset, ageMin: Int(age / 60),
                    status: stale ? 6 : 0, text: stale ? (codexErrText.isEmpty ? "Older than \(Int(UsageStore.codexStale / 60)) min" : codexErrText) : "", at: c.at, plan: c.plan, h5Win: c.h5Mins, d7Win: c.d7Mins)
    }
    func describe() -> [String: Any] {
        var out = [String: Any]()
        for p in ["claude", "codex"] {
            let s = snap(p)
            func n(_ v: Int?) -> Any { v as Any? ?? NSNull() }
            var d: [String: Any] = ["status": s.status, "message": s.text, "used5h": n(s.h5), "used7d": n(s.d7), "left5h": n(s.h5.map { 100 - $0 }), "left7d": n(s.d7.map { 100 - $0 }),
                                    "resets5h": n(s.h5Reset.map { Int($0) }), "resets7d": n(s.d7Reset.map { Int($0) }), "window5hMins": n(s.h5Win), "window7dMins": n(s.d7Win),
                                    "updatedAt": n(s.at.map { Int($0.timeIntervalSince1970) }), "ageSeconds": n(s.at.map { Int(Date().timeIntervalSince($0)) }), "plan": s.plan]
            if p == "claude" { d["context"] = n(s.ctx); d["contextSize"] = n(s.ctxSize) }
            out[p] = d
        }
        return out
    }
    func setClaude(_ o: [String: Any]) {
        func i(_ k: String) -> Int? { (o[k] as? NSNumber).map { Int($0.doubleValue.rounded()) } }
        func d(_ k: String) -> Double? { (o[k] as? NSNumber)?.doubleValue }
        claude = Claude(ctx: i("ctx"), ctxSize: i("ctxSize"), h5: i("h5"), h5Reset: d("h5Reset"), d7: i("d7"), d7Reset: d("d7Reset"), at: Date())
        onChange?()
    }
    /// Codex limits through the official app-server. Polled slowly (every 10 min), and on demand: connect, a finished Codex turn, a window reset, or the web button.
    func refreshCodex(force: Bool = false) {
        if codexInFlight { return }
        if !force, let a = codexAttempt, Date().timeIntervalSince(a) < 20 { return }
        codexInFlight = true; codexAttempt = Date()
        AIHooks.rpc("account/rateLimits/read", timeout: 25) { r in
            DispatchQueue.main.async {
                self.codexInFlight = false
                if let rl = r?["rateLimits"] as? [String: Any] {
                    func win(_ k: String) -> (Int?, Double?, Int?) { let w = rl[k] as? [String: Any]; return ((w?["usedPercent"] as? NSNumber).map { max(0, min(100, Int($0.doubleValue.rounded()))) }, (w?["resetsAt"] as? NSNumber)?.doubleValue, (w?["windowDurationMins"] as? NSNumber)?.intValue) }
                    let a = win("primary"), b = win("secondary")
                    self.codex = Codex(h5: a.0, h5Reset: a.1, h5Mins: a.2, d7: b.0, d7Reset: b.1, d7Mins: b.2, plan: (rl["planType"] as? String) ?? "", at: Date())
                    self.codexErrKind = 0; self.codexErrText = ""
                } else if let e = r?["__error"] as? String {
                    let l = e.lowercased()
                    let auth = ["auth", "sign", "login", "log in", "unauthorized", "401", "token", "chatgpt"].contains { l.contains($0) }
                    self.codexErrKind = auth ? 2 : 1; self.codexErrText = auth ? "Codex is not signed in with ChatGPT (open the Codex app and sign in)" : "Codex refused the limit request"
                    Log.shared.write("CODEX_USAGE error kind=\(self.codexErrKind)")
                } else {
                    self.codexErrKind = 3; self.codexErrText = "Codex app-server did not answer (network or app problem)"
                    Log.shared.write("CODEX_USAGE no answer")
                }
                self.onChange?()
            }
        }
    }
    /// Called every second by AIHub: slow poll, and an immediate re-read once a window has reset.
    func tick() {
        let now = Date(), t = now.timeIntervalSince1970
        guard AIHooks.codexBinary != nil else { return }
        let last = codexAttempt ?? .distantPast
        if now.timeIntervalSince(last) >= UsageStore.codexInterval { refreshCodex(); return }
        if let c = codex, now.timeIntervalSince(last) >= 30, [c.h5Reset, c.d7Reset].contains(where: { $0 != nil && $0! <= t && c.at.timeIntervalSince1970 < $0! }) { refreshCodex() }
    }
}
