import Foundation

/// Sends one notification at a time to the NU87 bubble: NS|id|kind|prio, NT|id|hex(title) chunks, NB|id|hex(body) chunks, NE|id|titleLen|bodyLen,
/// every line <= 20 bytes (default ATT MTU). Completes only on the board's `NACK|id|OK` (so a test/real notification is never reported as shown unless the board stored it).
/// kind: t = test (Companion test button), g = Gmail, c = AI, m = other. Reusable by any future source (mail, messenger).
final class NotifyHub {
    struct Item { var kind: Character; var prio: Int; var title: String; var body: String }
    unowned let ble: BLEClient
    init(ble: BLEClient) { self.ble = ble }
    private var queue: [(Item, (Result<Void, SyncError>) -> Void)] = []
    private var active = false, nextID: UInt8 = 1
    private var waiting: (id: UInt8, done: (String) -> Void)?

    static func clip(_ s: String, bytes: Int) -> String {
        var out = "", n = 0
        for ch in s.unicodeScalars where ch.value >= 32 && ch.value != 127 { let c = String(ch).utf8.count; if n + c > bytes { break }; out.unicodeScalars.append(ch); n += c }
        return out
    }
    func send(_ item: Item, done: @escaping (Result<Void, SyncError>) -> Void) {
        guard ble.isReady else { return done(.failure(.notConnected)) }
        queue.append((item, done)); pump()
    }
    func handle(_ text: String) -> Bool {
        var any = false
        for l in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) where l.hasPrefix("NACK|") {
            let f = l.split(separator: "|").map(String.init)
            if f.count == 3, let id = UInt8(f[1], radix: 16), let w = waiting, w.id == id { w.done(f[2]) }
            any = true
        }
        return any
    }
    private func pump() {
        guard !active, !queue.isEmpty else { return }
        active = true; let (item, done) = queue.removeFirst()
        let id = nextID; nextID = nextID >= 254 ? 1 : nextID + 1
        let title = NotifyHub.clip(item.title, bytes: 63), body = NotifyHub.clip(item.body, bytes: 39)
        let t = Array(title.utf8), b = Array(body.utf8)
        var lines = [String(format: "NS|%02X|%c|%d", id, item.kind.asciiValue ?? 109, max(0, min(3, item.prio)))]
        func hex(_ a: ArraySlice<UInt8>) -> String { a.map { String(format: "%02X", $0) }.joined() }
        var i = 0; while i < t.count { lines.append(String(format: "NT|%02X|", id) + hex(t[i..<min(i + 6, t.count)])); i += 6 }
        i = 0; while i < b.count { lines.append(String(format: "NB|%02X|", id) + hex(b[i..<min(i + 6, b.count)])); i += 6 }
        lines.append(String(format: "NE|%02X|%02X|%02X", id, t.count, b.count))
        func finish(_ r: Result<Void, SyncError>) { waiting = nil; active = false; done(r); pump() }
        func step(_ n: Int) {
            if n == lines.count {
                waiting = (id, { code in code == "OK" ? finish(.success(())) : finish(.failure(.device("notification \(code)"))) })
                DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if let w = self.waiting, w.id == id { finish(.failure(.timeout("no ACK from NU87 for notification"))) } }
                return
            }
            guard ble.sendLine(lines[n]) else { return finish(.failure(.notConnected)) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { step(n + 1) }
        }
        step(0)
    }
}
