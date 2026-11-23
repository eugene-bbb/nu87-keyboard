import Foundation

/// Installs the hook script (Claude Code ~/.claude/settings.json, Codex ~/.codex/hooks.json) and the Claude statusline script. Existing entries are kept, a backup is made once.
/// Codex only runs hooks the user has trusted; trust is granted by the user in the Codex app (Settings > Hooks), never written by this app.
enum AIHooks {
    static var support: URL { Config.url.deletingLastPathComponent() }
    static var hooksDir: URL { support.appendingPathComponent("hooks") }
    static var scriptURL: URL { hooksDir.appendingPathComponent("nu87-ai-hook.sh") }
    static var statuslineURL: URL { hooksDir.appendingPathComponent("nu87-claude-statusline.sh") }
    static func writeMode(_ m: String) { try? FileManager.default.createDirectory(at: hooksDir, withIntermediateDirectories: true); try? m.write(to: hooksDir.appendingPathComponent("content-mode"), atomically: true, encoding: .utf8) }

    static let script = """
    #!/bin/sh
    # NU87 AI state hook. Sends provider, event, session/turn id, a timestamp and (only if enabled in the NU87 web settings) a short slice of the user's
    # request / the final answer to the LOCAL Companion on 127.0.0.1. The Companion masks and shortens it; nothing leaves this Mac.
    p="$1"; e="$2"
    mode=$(cat "$(dirname "$0")/content-mode" 2>/dev/null); [ -z "$mode" ] && mode=title
    in=$(cat)
    ts=$(/usr/bin/perl -MTime::HiRes=time -e 'printf "%d", time*1000')
    body=""
    if [ -x /usr/bin/jq ]; then
      body=$(printf '%s' "$in" | /usr/bin/jq -c --arg p "$p" --arg e "$e" --argjson ts "$ts" --arg mode "$mode" '{provider:$p,event:$e,session:((.session_id//.thread_id//"unknown")|tostring|.[0:64]),turn:((.turn_id//.prompt_id//"")|tostring|.[0:64]),ts:$ts,prompt:(if $mode!="off" and $e=="start" then ((.prompt//"")|tostring|.[0:400]) else null end),reply:(if $mode=="full" and $e=="done" then ((.last_assistant_message//"")|tostring|.[0:900]) else null end),keys:(keys)}' 2>/dev/null)
    fi
    if [ -z "$body" ]; then
      sid=$(printf '%s' "$in" | /usr/bin/plutil -extract session_id raw -o - - 2>/dev/null | /usr/bin/tr -cd 'A-Za-z0-9_-' | /usr/bin/cut -c1-64); [ -z "$sid" ] && sid=unknown
      body="{\\"provider\\":\\"$p\\",\\"event\\":\\"$e\\",\\"session\\":\\"$sid\\",\\"ts\\":$ts}"
    fi
    ( /usr/bin/curl -s -m 2 -X POST -H 'Origin: http://127.0.0.1:17871' -H 'X-NU87: 1' -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:17871/api/ai-event >/dev/null 2>&1 & )
    exit 0

    """
    static let statusline = """
    #!/bin/sh
    # NU87: forwards the numbers of the official Claude Code statusline JSON (context window and rate limits) to the local Companion and prints a short status line.
    in=$(cat)
    if [ -x /usr/bin/jq ]; then
      body=$(printf '%s' "$in" | /usr/bin/jq -c '{provider:"claude",ctx:(.context_window.used_percentage//null),ctxSize:(.context_window.context_window_size//null),h5:(.rate_limits.five_hour.used_percentage//null),h5Reset:(.rate_limits.five_hour.resets_at//null),d7:(.rate_limits.seven_day.used_percentage//null),d7Reset:(.rate_limits.seven_day.resets_at//null)}' 2>/dev/null)
      [ -n "$body" ] && ( /usr/bin/curl -s -m 2 -X POST -H 'Origin: http://127.0.0.1:17871' -H 'X-NU87: 1' -H 'Content-Type: application/json' -d "$body" http://127.0.0.1:17871/api/ai-usage >/dev/null 2>&1 & )
      model=$(printf '%s' "$in" | /usr/bin/jq -r '.model.display_name // "Claude"' 2>/dev/null)
      ctx=$(printf '%s' "$in" | /usr/bin/jq -r '.context_window.used_percentage // empty | floor' 2>/dev/null)
      if [ -n "$ctx" ]; then printf '%s · context %s%%' "$model" "$ctx"; else printf '%s' "$model"; fi
    fi

    """
    // UserPromptSubmit -> "start" (new turn, carries the request for the short title); PostToolUse -> "working" (activity evidence only)
    static let claudeEvents: [(String, String)] = [("UserPromptSubmit", "start"), ("PostToolUse", "working"), ("PermissionRequest", "approval"), ("Stop", "done"), ("StopFailure", "error"), ("SessionEnd", "end")]
    static let codexEvents: [(String, String)] = [("UserPromptSubmit", "start"), ("PostToolUse", "working"), ("PermissionRequest", "approval"), ("Stop", "done"), ("Interrupt", "interrupt"), ("SessionEnd", "end")]
    static var claudeURL: URL { URL(fileURLWithPath: NSHomeDirectory() + "/.claude/settings.json") }
    static var codexURL: URL { URL(fileURLWithPath: NSHomeDirectory() + "/.codex/hooks.json") }

    static func installed() -> [String: Any] {
        func has(_ u: URL, _ m: String = "nu87-ai-hook.sh") -> Bool { ((try? String(contentsOf: u, encoding: .utf8)) ?? "").contains(m) }
        let root = (try? JSONSerialization.jsonObject(with: Data(contentsOf: claudeURL))) as? [String: Any]
        let sl = (root?["statusLine"] as? [String: Any])?["command"] as? String
        return ["claude": has(claudeURL), "codex": has(codexURL), "script": FileManager.default.isExecutableFile(atPath: scriptURL.path),
                "claudeStatusline": (sl ?? "").contains("nu87-claude-statusline.sh"), "otherStatusline": sl != nil && !(sl ?? "").contains("nu87-claude-statusline.sh")]
    }
    private static func writeScripts() -> SyncError? {
        let fm = FileManager.default
        do { try fm.createDirectory(at: hooksDir, withIntermediateDirectories: true)
            for (u, c) in [(scriptURL, script), (statuslineURL, statusline)] { try c.write(to: u, atomically: true, encoding: .utf8); try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: u.path) } }
        catch { return .device("could not write the hook scripts: \(error.localizedDescription)") }
        return nil
    }
    private static func readJSON(_ url: URL) -> (root: [String: Any], err: SyncError?) {
        guard let d = try? Data(contentsOf: url), !d.isEmpty else { return ([:], nil) }
        guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return ([:], .invalid("\(url.lastPathComponent) is not a JSON object; left untouched")) }
        let bak = url.appendingPathExtension("nu87-backup"); if !FileManager.default.fileExists(atPath: bak.path) { try? d.write(to: bak) }
        return (o, nil)
    }
    static func install(provider: String) -> Result<String, SyncError> {
        if let e = writeScripts() { return .failure(e) }
        let url = provider == "codex" ? codexURL : claudeURL, events = provider == "codex" ? codexEvents : claudeEvents
        let (r, err) = readJSON(url); if let e = err { return .failure(e) }
        var root = r, hooks = root["hooks"] as? [String: Any] ?? [:]
        for (ev, arg) in events {
            var groups = hooks[ev] as? [[String: Any]] ?? []
            // replace an older NU87 entry for this provider+event (e.g. "working" -> "start"), keep everything else
            groups = groups.compactMap { g in
                var hs = g["hooks"] as? [[String: Any]] ?? []
                hs.removeAll { ($0["command"] as? String ?? "").contains("nu87-ai-hook.sh") && ($0["command"] as? String ?? "").contains(" \(provider) ") }
                if hs.isEmpty { return nil }; var g2 = g; g2["hooks"] = hs; return g2 }
            var h: [String: Any] = ["type": "command", "command": "\"\(scriptURL.path)\" \(provider) \(arg)"]
            if provider == "codex" { h["async"] = true; h["timeoutSec"] = 3 }
            groups.append(["hooks": [h]]); hooks[ev] = groups
        }
        root["hooks"] = hooks
        guard let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]), (try? out.write(to: url, options: .atomic)) != nil else { return .failure(.device("could not write \(url.path)")) }
        return .success(url.path)
    }
    /// Claude statusline for context / rate-limit numbers. An existing statusline of the user is never replaced.
    static func installStatusline() -> Result<String, SyncError> {
        if let e = writeScripts() { return .failure(e) }
        let (r, err) = readJSON(claudeURL); if let e = err { return .failure(e) }
        var root = r
        if let sl = root["statusLine"] as? [String: Any], !((sl["command"] as? String) ?? "").contains("nu87-claude-statusline.sh") { return .failure(.invalid("you already have a Claude Code statusline; it was left unchanged (add the numbers via its own script instead)")) }
        root["statusLine"] = ["type": "command", "command": "\"\(statuslineURL.path)\"", "padding": 0]
        guard let out = try? JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]), (try? out.write(to: claudeURL, options: .atomic)) != nil else { return .failure(.device("could not write settings.json")) }
        return .success(claudeURL.path)
    }

    // MARK: Codex app-server probes (separate short-lived process; account-level data and hook trust state only, never a thread of the Desktop app)
    static var codexBinary: String? {
        guard let app = ActionEngine.appURL("com.openai.codex") else { return nil }
        let p = app.appendingPathComponent("Contents/Resources/codex-cli/bin/codex").path
        return FileManager.default.isExecutableFile(atPath: p) ? p : nil
    }
    static func rpc(_ method: String, params: [String: Any]? = nil, timeout: Double = 20, _ done: @escaping ([String: Any]?) -> Void) {
        guard let bin = codexBinary else { return done(nil) }
        DispatchQueue.global().async {
            let p = Process(); p.executableURL = URL(fileURLWithPath: bin); p.arguments = ["app-server"]
            let inP = Pipe(), outP = Pipe(); p.standardInput = inP; p.standardOutput = outP; p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { return done(nil) }
            let sem = DispatchSemaphore(value: 0); var result: [String: Any]?; var buf = Data()
            outP.fileHandleForReading.readabilityHandler = { h in
                buf.append(h.availableData)
                while let nl = buf.firstIndex(of: 10) {
                    let line = buf[..<nl]; buf = Data(buf[buf.index(after: nl)...])
                    if let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any], (o["id"] as? Int) == 2 { if let e = o["error"] as? [String: Any] { result = ["__error": (e["message"] as? String) ?? "error"] } else { result = o["result"] as? [String: Any] }; sem.signal() }
                }
            }
            func send(_ o: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: o) { inP.fileHandleForWriting.write(d + Data("\n".utf8)) } }
            send(["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["clientInfo": ["name": "nu87-companion", "version": "1"]]])
            send(["jsonrpc": "2.0", "method": "initialized"])
            var m: [String: Any] = ["jsonrpc": "2.0", "id": 2, "method": method]; if let pr = params { m["params"] = pr }
            send(m)
            _ = sem.wait(timeout: .now() + timeout)
            outP.fileHandleForReading.readabilityHandler = nil; p.terminate()
            done(result)
        }
    }
    static var trustCache: [String: Any] = [:]
    static func refreshTrust() {
        rpc("hooks/list", params: ["cwds": [NSHomeDirectory()]], timeout: 12) { r in
            let hooks = ((r?["data"] as? [[String: Any]])?.first?["hooks"] as? [[String: Any]]) ?? []
            let mine = hooks.filter { ($0["command"] as? String ?? "").contains("nu87-ai-hook.sh") }
            let trusted = mine.filter { ($0["trustStatus"] as? String) == "trusted" || ($0["trustStatus"] as? String) == "managed" }.count
            DispatchQueue.main.async { trustCache = ["total": mine.count, "trusted": trusted, "checkedAgo": 0, "checkedAt": Date().timeIntervalSince1970] }
        }
    }
    static func refreshCodexUsage() { DispatchQueue.main.async { UsageStore.shared.refreshCodex(force: true) } }
}
