import Foundation
import Security
import CryptoKit
import AppKit

/// Keychain access is cached in memory and performed off the main thread: macOS may show an "allow access" dialog (after every rebuild of this ad-hoc signed app),
/// and a Keychain call on the main thread would freeze BLE, the local API and the UI until that dialog is answered.
enum Keychain {
    static let service = "com.nucode.nu87companion.gmail"
    static let names = ["client_id", "client_secret", "refresh_token", "kakao_rest_key"]
    private static let q = DispatchQueue(label: "nu87.keychain")
    private static let lock = NSLock()
    private static var cache = [String: String](), loaded = Set<String>()
    private static func query(_ key: String) -> [String: Any] { [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key] }
    /// Call once at launch (background): fills the cache. Until a name is loaded, get() reports it as missing.
    static func preload() {
        q.async { for k in names { load(k) } }
    }
    private static func load(_ key: String) {
        var o = query(key); o[kSecReturnData as String] = true; o[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?; let st = SecItemCopyMatching(o as CFDictionary, &out)
        lock.lock(); defer { lock.unlock() }
        if st == errSecSuccess, let d = out as? Data, let v = String(data: d, encoding: .utf8) { cache[key] = v } else { cache[key] = nil }
        loaded.insert(key)
    }
    static func get(_ key: String) -> String? { lock.lock(); defer { lock.unlock() }; return cache[key] }
    static var isLoaded: Bool { lock.lock(); defer { lock.unlock() }; return loaded.count >= names.count }
    static func set(_ key: String, _ value: String) {
        lock.lock(); cache[key] = value; loaded.insert(key); lock.unlock()
        q.async {
            let o = query(key); SecItemDelete(o as CFDictionary)
            var a = o; a[kSecValueData as String] = Data(value.utf8); a[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
            SecItemAdd(a as CFDictionary, nil)
        }
    }
    static func delete(_ key: String) {
        lock.lock(); cache[key] = nil; lock.unlock()
        q.async { SecItemDelete(query(key) as CFDictionary) }
    }
}

/// Gmail new-mail notifications. Scope gmail.metadata only: sender + subject headers, never body or attachments.
/// OAuth 2.0 installed-app flow with PKCE and a loopback redirect served by LocalAPI; tokens only in the macOS Keychain.
final class GmailClient {
    static let redirect = "http://127.0.0.1:\(LocalAPI.port)/oauth/callback"
    static let scope = "https://www.googleapis.com/auth/gmail.metadata"
    unowned let hub: NotifyHub
    init(hub: NotifyHub) { self.hub = hub }
    private let ud = UserDefaults.standard
    private(set) var lastCheck: Date?, lastError = "", lastKind = "", lastSent = "", lastOK: Bool?, lastResult = "", lastNewAt: Date?, lastNewCount = 0, lastSentAt: Date?
    private var accessToken: (String, Date)?, pending: (state: String, verifier: String)?, timer: Timer?, polling = false, pollStarted = Date.distantPast
    struct GErr: Error { var kind: String; var msg: String }   // kind: auth (sign in again), permission, network, api, notready

    var hasClient: Bool { Keychain.get("client_id") != nil && Keychain.get("client_secret") != nil }
    var connected: Bool { Keychain.get("refresh_token") != nil }
    var email: String { ud.string(forKey: "gmailEmail") ?? "" }
    var enabled: Bool { get { ud.object(forKey: "gmailEnabled") as? Bool ?? true } set { ud.set(newValue, forKey: "gmailEnabled") } }
    private var seen: [String] { get { ud.stringArray(forKey: "gmailSeen") ?? [] } set { ud.set(Array(newValue.suffix(300)), forKey: "gmailSeen") } }
    /// Mail that arrived in the INBOX but has not been announced yet (board offline / ACK missing). Survives a restart.
    private var queued: [String] { get { ud.stringArray(forKey: "gmailQueued") ?? [] } set { ud.set(Array(newValue.suffix(30)), forKey: "gmailQueued") } }
    private var historyId: String? { get { ud.string(forKey: "gmailHistoryId") } set { ud.set(newValue, forKey: "gmailHistoryId") } }
    func status() -> [String: Any] {
        let f = ISO8601DateFormatter()
        let id = Keychain.get("client_id") ?? "", sec = Keychain.get("client_secret") ?? ""
        return ["hasClient": hasClient, "connected": connected, "email": email, "enabled": enabled, "lastCheck": lastCheck.map { f.string(from: $0) } ?? "", "lastError": lastError, "lastErrorKind": lastKind,
         "lastOK": lastOK as Any? ?? NSNull(), "lastResult": lastResult, "lastNewAt": lastNewAt.map { f.string(from: $0) } ?? "", "lastNewCount": lastNewCount, "lastSentAt": lastSentAt.map { f.string(from: $0) } ?? "",
         "queued": queued.count, "baseline": historyId != nil, "polling": polling, "intervalSeconds": 90, "scope": "gmail.metadata (sender + subject only)",
         "clientShape": ["idLooksValid": id.hasSuffix(".apps.googleusercontent.com"), "secretLength": sec.count, "hasWhitespace": id.contains(where: \.isWhitespace) || sec.contains(where: \.isWhitespace)]]
    }
    func setClient(id: String, secret: String) { Keychain.set("client_id", id.trimmingCharacters(in: .whitespacesAndNewlines)); Keychain.set("client_secret", secret.trimmingCharacters(in: .whitespacesAndNewlines)) }

    func start() {   // 60-120 s: 90 s with a little jitter; first check shortly after launch
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { [weak self] _ in self?.check() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.check() }
    }

    // MARK: OAuth
    func authURL() -> Result<URL, SyncError> {
        guard let cid = Keychain.get("client_id"), Keychain.get("client_secret") != nil else { return .failure(.invalid("enter the Google OAuth client ID and secret first")) }
        func rnd(_ n: Int) -> String { Data((0..<n).map { _ in UInt8.random(in: 0...255) }).base64URL }
        let verifier = rnd(48), state = rnd(16); pending = (state, verifier)
        var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        c.queryItems = [.init(name: "client_id", value: cid), .init(name: "redirect_uri", value: GmailClient.redirect), .init(name: "response_type", value: "code"), .init(name: "scope", value: GmailClient.scope),
                        .init(name: "code_challenge", value: Data(SHA256.hash(data: Data(verifier.utf8))).base64URL), .init(name: "code_challenge_method", value: "S256"),
                        .init(name: "access_type", value: "offline"), .init(name: "prompt", value: "consent"), .init(name: "state", value: state)]
        return .success(c.url!)
    }
    func connect() -> Result<String, SyncError> {
        switch authURL() { case .failure(let e): return .failure(e); case .success(let u): NSWorkspace.shared.open(u); return .success(u.absoluteString) }
    }
    /// Browser redirect lands here (GET /oauth/callback). Returns the HTML page shown to the user.
    func handleCallback(query: [String: String], done: @escaping (String) -> Void) {
        func page(_ t: String) -> String { "<!doctype html><meta charset=utf-8><body style='font:16px -apple-system;padding:40px'>\(t)<p>You can close this tab and return to NU87 Key Mapping.</p>" }
        guard let p = pending, query["state"] == p.state else { return done(page("Sign-in rejected: unknown state.")) }
        pending = nil
        if let e = query["error"] { lastError = "Google: \(e)"; return done(page("Google returned: \(e)")) }
        guard let code = query["code"], let cid = Keychain.get("client_id"), let sec = Keychain.get("client_secret") else { return done(page("Missing code.")) }
        form("https://oauth2.googleapis.com/token", ["code": code, "client_id": cid, "client_secret": sec, "code_verifier": p.verifier, "redirect_uri": GmailClient.redirect, "grant_type": "authorization_code"]) { [weak self] j, err in
            guard let s = self else { return }
            guard let j = j, let rt = j["refresh_token"] as? String, let at = j["access_token"] as? String else { s.lastError = err ?? (j?["error_description"] as? String) ?? "token exchange failed"; return done(page("Could not connect: \(s.lastError)")) }
            Keychain.set("refresh_token", rt); s.accessToken = (at, Date().addingTimeInterval((j["expires_in"] as? Double ?? 3000) - 60))
            s.api("profile") { j, _ in
                s.ud.set(j?["emailAddress"] as? String ?? "", forKey: "gmailEmail")
                if let h = j?["historyId"] { s.historyId = "\(h)"; s.queued = [] }
                s.lastError = ""; s.lastKind = ""; s.lastOK = true; Log.shared.write("Gmail connected"); done(page("Gmail connected (metadata only)."))
            }
        }
    }
    func disconnect() {
        if let t = Keychain.get("refresh_token") { form("https://oauth2.googleapis.com/revoke", ["token": t]) { _, _ in } }
        Keychain.delete("refresh_token"); accessToken = nil; ud.removeObject(forKey: "gmailEmail"); ud.removeObject(forKey: "gmailSeen"); ud.removeObject(forKey: "gmailHistoryId"); ud.removeObject(forKey: "gmailQueued"); lastError = ""; lastKind = ""; lastOK = nil
        Log.shared.write("Gmail disconnected")
    }

    // MARK: Gmail (metadata only)
    private func token(_ done: @escaping (String?, GErr?) -> Void) {
        if let (t, exp) = accessToken, exp > Date() { return done(t, nil) }
        guard Keychain.isLoaded else { return done(nil, GErr(kind: "notready", msg: "Keychain not read yet")) }
        guard let rt = Keychain.get("refresh_token"), let cid = Keychain.get("client_id"), let sec = Keychain.get("client_secret") else { return done(nil, GErr(kind: "auth", msg: "Gmail credentials missing: connect Gmail again")) }
        if sec.count < 20 { return done(nil, GErr(kind: "auth", msg: "the OAuth client secret saved on this Mac is only \(sec.count) characters (Google's are about 35): enter the client ID and secret again, then Connect Gmail")) }
        form("https://oauth2.googleapis.com/token", ["refresh_token": rt, "client_id": cid, "client_secret": sec, "grant_type": "refresh_token"]) { [weak self] j, err in
            guard let at = j?["access_token"] as? String else {
                if let e = j?["error"] as? String {
                    let d = (j?["error_description"] as? String) ?? ""
                    let hint = e == "invalid_client" ? "Google rejected the OAuth client ID / secret stored in this Mac" : e == "invalid_grant" ? "the Gmail authorization expired or was revoked" : e
                    return done(nil, GErr(kind: "auth", msg: "\(e): \(hint)\(d.isEmpty ? "" : " (\(d))"); reconnect Gmail"))
                }
                return done(nil, GErr(kind: "network", msg: err ?? "token request failed"))
            }
            self?.accessToken = (at, Date().addingTimeInterval((j?["expires_in"] as? Double ?? 3000) - 60)); done(at, nil)
        }
    }
    private func api(_ path: String, query: [String: [String]] = [:], _ done: @escaping ([String: Any]?, GErr?) -> Void) {
        token { [weak self] t, terr in
            guard let t = t else { return done(nil, terr ?? GErr(kind: "auth", msg: "no access token")) }
            var c = URLComponents(string: "https://gmail.googleapis.com/gmail/v1/users/me/\(path)")!
            c.queryItems = query.flatMap { k, vs in vs.map { URLQueryItem(name: k, value: $0) } }
            var r = URLRequest(url: c.url!); r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization"); r.timeoutInterval = 20
            URLSession.shared.dataTask(with: r) { d, resp, e in DispatchQueue.main.async {
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard let d = d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return done(nil, GErr(kind: "network", msg: e?.localizedDescription ?? "bad response (HTTP \(code))")) }
                if let err = j["error"] as? [String: Any] {
                    let m = err["message"] as? String ?? "error"
                    if code == 401 { self?.accessToken = nil }
                    let kind = code == 401 ? "auth" : code == 403 ? "permission" : code == 404 ? "notfound" : "api"
                    return done(nil, GErr(kind: kind, msg: "HTTP \(code): \(m)"))
                }
                done(j, nil) } }.resume()
        }
    }
    private func form(_ url: String, _ f: [String: String], _ done: @escaping ([String: Any]?, String?) -> Void) {
        var r = URLRequest(url: URL(string: url)!); r.httpMethod = "POST"; r.timeoutInterval = 20
        r.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var c = URLComponents(); c.queryItems = f.map { URLQueryItem(name: $0.key, value: $0.value) }
        r.httpBody = c.percentEncodedQuery?.data(using: .utf8)
        URLSession.shared.dataTask(with: r) { d, _, e in DispatchQueue.main.async { done(d.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }, e?.localizedDescription) } }.resume()
    }
    /// After connecting, only mail arriving later is announced: remember the mailbox position (historyId) instead of listing mail.
    private func baseline(_ done: @escaping () -> Void) {
        api("profile") { [weak self] j, err in
            if let h = j?["historyId"] { self?.historyId = "\(h)"; self?.queued = [] } else if let e = err { self?.lastKind = e.kind; self?.lastError = e.msg }
            done()
        }
    }
    private func fail(_ e: GErr) { lastKind = e.kind; lastError = e.msg; lastOK = false; lastResult = "failed"; Log.shared.write("GMAIL_ERROR reason=\(e.kind)") }

    /// New-mail detection: Gmail history (messageAdded into INBOX since the stored historyId), so mail that was already read, or that arrived between two polls, is not missed
    /// and nothing depends on a single list of "unread ids". Works with gmail.metadata (no `q` search is used, which that scope forbids). Only Subject / From headers are read.
    ///  - announced: arrived in INBOX, still UNREAD, not older than 30 min, at most 3 per poll (rest of a burst is marked seen)
    ///  - not announced: already read, moved out of the INBOX / deleted before the poll, sent or draft mail, or already announced (message id kept in `gmailSeen`)
    func check(manual: Bool = false, done: ((String) -> Void)? = nil) {
        if polling && Date().timeIntervalSince(pollStarted) > 90 { polling = false }   // watchdog: a poll can never block the next ones for long
        guard connected else { done?("not connected"); return }
        guard enabled || manual else { done?("Gmail alerts are switched off"); return }
        guard !polling else { done?("a check is already running"); return }
        polling = true; pollStarted = Date(); Log.shared.write("GMAIL_POLL_START\(manual ? " manual" : "")")
        func end(_ m: String) { polling = false; lastCheck = Date(); lastResult = lastOK == false ? "failed" : "ok"; done?(m) }
        func finish(ok m: String) { lastOK = true; lastKind = ""; lastError = ""; end(m) }
        guard let start = historyId else {
            return baseline { [weak self] in
                guard let s = self else { return }
                if s.historyId != nil { Log.shared.write("GMAIL_POLL_RESULT count=0 (baseline set)"); finish(ok: "baseline set: only mail arriving from now on is announced") }
                else { s.fail(GErr(kind: s.lastKind.isEmpty ? "api" : s.lastKind, msg: s.lastError.isEmpty ? "could not read the mailbox position" : s.lastError)); end("check failed") }
            }
        }
        collect(start: start, page: nil, ids: []) { [weak self] res in
            guard let s = self else { return }
            switch res {
            case .failure(let e):
                if e.kind == "notfound" { s.historyId = nil; Log.shared.write("GMAIL_POLL_RESULT count=0 (history expired, new baseline)"); return s.baseline { finish(ok: "history expired: new baseline set") } }
                if e.kind == "notready" { return end("waiting for Keychain") }
                s.fail(e); end("check failed: \(e.msg)")
            case .success(let (ids, newest)):
                let seenNow = Set(s.seen), already = Set(s.queued)
                let added = ids.filter { !seenNow.contains($0) && !already.contains($0) }
                Log.shared.write("GMAIL_POLL_RESULT count=\(ids.count) new=\(added.count)")
                if !added.isEmpty { s.lastNewAt = Date(); s.lastNewCount = added.count; for id in added { Log.shared.write("GMAIL_NEW_MESSAGE id=\(id)") } }
                s.queued = s.queued + added
                if let n = newest { s.historyId = n }   // position advances only after the ids are safely queued
                s.announce(end: { m in finish(ok: m) }, fail: { e in s.fail(e); end("check failed: \(e.msg)") })
            }
        }
    }
    private func collect(start: String, page: String?, ids: [String], _ done: @escaping (Result<([String], String?), GErr>) -> Void) {
        var q: [String: [String]] = ["startHistoryId": [start], "historyTypes": ["messageAdded"], "labelId": ["INBOX"], "maxResults": ["100"]]
        if let p = page { q["pageToken"] = [p] }
        api("history", query: q) { [weak self] j, err in
            if let err = err { return done(.failure(err)) }
            var out = ids
            for h in (j?["history"] as? [[String: Any]]) ?? [] { for m in (h["messagesAdded"] as? [[String: Any]]) ?? [] {
                guard let msg = m["message"] as? [String: Any], let id = msg["id"] as? String else { continue }
                let labels = msg["labelIds"] as? [String] ?? []
                if labels.contains("SENT") || labels.contains("DRAFT") { continue }
                if !out.contains(id) { out.append(id) } } }
            if let n = j?["nextPageToken"] as? String, out.count < 300 { return self?.collect(start: start, page: n, ids: out, done) ?? () }
            done(.success((out, (j?["historyId"]).map { "\($0)" })))
        }
    }
    /// Reads the Subject / From headers of the queued mail and sends the notifications through the normal NotifyHub -> BLE path.
    private func announce(end: @escaping (String) -> Void, fail: @escaping (GErr) -> Void) {
        let ids = Array(queued.prefix(10))
        guard !ids.isEmpty else { return end("no new mail") }
        var metas: [(id: String, date: Double, subject: String, from: String)] = [], gone: [String] = [], firstErr: GErr?
        let group = DispatchGroup()
        for id in ids {
            group.enter()
            api("messages/\(id)", query: ["format": ["metadata"], "metadataHeaders": ["Subject", "From"]]) { j, err in
                if let j = j {
                    let labels = j["labelIds"] as? [String] ?? []
                    if labels.contains("INBOX") && labels.contains("UNREAD") {
                        let hs = (j["payload"] as? [String: Any])?["headers"] as? [[String: Any]] ?? []
                        func h(_ n: String) -> String { hs.first { ($0["name"] as? String)?.lowercased() == n.lowercased() }?["value"] as? String ?? "" }
                        metas.append((id, Double(j["internalDate"] as? String ?? "0") ?? 0, MIME.decode(h("Subject")), MIME.sender(h("From"))))
                    } else { gone.append(id) }   // read, moved or deleted already: nothing to announce
                } else if err?.kind == "notfound" { gone.append(id) } else { firstErr = firstErr ?? err }
                group.leave()
            }
        }
        group.notify(queue: .main) { [self] in
            func settle(_ id: String) { seen = seen + [id]; queued = queued.filter { $0 != id } }
            for id in gone { settle(id) }
            if let e = firstErr, metas.isEmpty { return fail(e) }
            metas.sort { $0.date < $1.date }
            var chain = metas.makeIterator(), sent = 0
            func next() {
                guard let m = chain.next() else { return end(sent == 0 ? "no notification needed" : "notified \(sent)") }
                let ageMin = (Date().timeIntervalSince1970 * 1000 - m.date) / 60000
                if ageMin > 30 || sent >= 3 { settle(m.id); return next() }   // old mail / burst: marked seen, not announced
                guard hub.ble.isReady else { return end("NU87 not connected: \(queued.count) waiting, will retry") }   // stays queued
                Log.shared.write("GMAIL_NOTIFICATION_QUEUED id=\(m.id)")
                hub.send(.init(kind: "g", prio: 2, title: m.subject.isEmpty ? "(no subject)" : m.subject, body: m.from)) { [self] r in
                    if case .success = r { settle(m.id); sent += 1; lastSent = m.subject; lastSentAt = Date(); Log.shared.write("GMAIL_NOTIFICATION_SENT id=\(m.id)") }
                    else { Log.shared.write("GMAIL_ERROR reason=notification_not_confirmed"); lastKind = "device"; lastError = "NU87 did not confirm the notification (it will be retried)" }
                    next()
                }
            }
            next()
        }
    }
}

enum MIME {
    /// RFC 2047 encoded-words (=?UTF-8?B?..?= / =?EUC-KR?Q?..?=) -> plain text.
    static func decode(_ s: String) -> String {
        guard s.contains("=?") else { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        var out = "", rest = Substring(s), lastWasWord = false
        while let a = rest.range(of: "=?") {
            let pre = rest[..<a.lowerBound]
            if let (w, endIdx) = scanWord(rest, from: a.upperBound) {
                if !(lastWasWord && pre.allSatisfy { $0 == " " || $0 == "\t" || $0 == "\r" || $0 == "\n" }) { out += pre }
                out += w; rest = rest[endIdx...]; lastWasWord = true
            } else { out += rest[..<a.upperBound]; rest = rest[a.upperBound...]; lastWasWord = false }
        }
        return (out + rest).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    /// "=?charset?enc?text?=": the terminator is searched only after the 3rd '?' (Q text may contain "?=" lookalikes).
    private static func scanWord(_ r: Substring, from i: Substring.Index) -> (String, Substring.Index)? {
        guard let q1 = r[i...].firstIndex(of: "?"), let q2 = r[r.index(after: q1)...].firstIndex(of: "?"),
              let e = r[r.index(after: q2)...].range(of: "?="), let w = word(String(r[i..<e.lowerBound])) else { return nil }
        return (w, e.upperBound)
    }
    private static func word(_ body: String) -> String? {
        let p = body.split(separator: "?", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        guard p.count == 3 else { return nil }
        let cs = p[0].split(separator: "*").first.map(String.init) ?? p[0]
        var bytes = [UInt8]()
        if p[1].uppercased() == "B" { guard let d = Data(base64Encoded: p[2].padding(toLength: (p[2].count + 3) / 4 * 4, withPad: "=", startingAt: 0)) else { return nil }; bytes = [UInt8](d) }
        else if p[1].uppercased() == "Q" {
            let u = Array(p[2].utf8); var i = 0
            while i < u.count { if u[i] == 95 { bytes.append(32) } else if u[i] == 61, i + 2 < u.count, let v = UInt8(String(bytes: u[i + 1...i + 2], encoding: .ascii) ?? "", radix: 16) { bytes.append(v); i += 2 } else { bytes.append(u[i]) }; i += 1 }
        } else { return nil }
        let enc: String.Encoding
        switch cs.lowercased() {
        case "utf-8", "utf8": enc = .utf8
        case "euc-kr", "ks_c_5601-1987", "cp949": enc = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.EUC_KR.rawValue)))
        case "iso-8859-1", "latin1": enc = .isoLatin1
        default: enc = .utf8
        }
        return String(bytes: bytes, encoding: enc) ?? String(decoding: bytes, as: UTF8.self)
    }
    /// "Display Name" <a@b.c> -> Display Name (decoded), else the address.
    static func sender(_ from: String) -> String {
        let d = decode(from)
        if let lt = d.firstIndex(of: "<") {
            let name = d[..<lt].trimmingCharacters(in: CharacterSet(charactersIn: " \"'\t"))
            if !name.isEmpty { return name }
            if let gt = d.firstIndex(of: ">"), lt < gt { return String(d[d.index(after: lt)..<gt]) }
        }
        return d
    }
}
extension Data { var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") } }
