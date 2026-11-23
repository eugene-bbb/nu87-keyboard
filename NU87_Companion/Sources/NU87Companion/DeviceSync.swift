import Foundation

/// Settings model = the firmware's persisted state (keymap, knob, RGB). Mirrors the 90-byte blob in firmware_impl.h ("Web settings sync").
struct DeviceConfig: Codable, Equatable {
    struct Knob: Codable, Equatable { var mode: Int; var map: [[Int]] }                 // map[6][4] = CW, CCW, CLICK, HOLD
    struct RGB: Codable, Equatable { var effect: Int; var color: Int; var brightness: Int; var speed10: Int; var hue: Int } // hue in degrees (0...358, 2° steps)
    var active: Int            // profile 0 = Dev, 1 = Media
    var keys: [[[Int]]]        // [profile 2][key 9][single, double, hold]
    var knob: Knob
    var rgb: RGB
    var rev: Int = 0           // device-side change counter (not part of equality)
    static func == (a: DeviceConfig, b: DeviceConfig) -> Bool { a.active == b.active && a.keys == b.keys && a.knob == b.knob && a.rgb == b.rgb }

    static func crc16(_ b: ArraySlice<UInt8>) -> UInt16 {
        var c: UInt16 = 0xFFFF
        for x in b { c ^= UInt16(x); for _ in 0..<8 { c = (c & 1) != 0 ? (c >> 1) ^ 0xA001 : c >> 1 } }
        return c
    }
    static func decode(_ b: [UInt8]) -> DeviceConfig? {
        guard b.count == 90, b[0] == 1, b[1] <= 1, crc16(b[0..<88]) == UInt16(b[88]) | UInt16(b[89]) << 8 else { return nil }
        var keys = [[[Int]]](); for p in 0..<2 { keys.append((0..<9).map { k in (0..<3).map { Int(b[2 + p * 27 + k * 3 + $0]) } }) }
        let map = (0..<6).map { m in (0..<4).map { Int(b[57 + m * 4 + $0]) } }
        return DeviceConfig(active: Int(b[1]), keys: keys, knob: Knob(mode: Int(b[56]), map: map),
                            rgb: RGB(effect: Int(b[81]), color: Int(b[82]), brightness: Int(b[83]), speed10: Int(b[84]), hue: Int(b[85]) * 2), rev: Int(b[86]))
    }
    /// nil when out of range (the device validates again, including that every action ID exists).
    func encode() -> [UInt8]? {
        guard (0...1).contains(active), keys.count == 2, keys.allSatisfy({ $0.count == 9 && $0.allSatisfy { $0.count == 3 } }),
              (0..<6).contains(knob.mode), knob.map.count == 6, knob.map.allSatisfy({ $0.count == 4 }),
              (0...3).contains(rgb.effect), (0...3).contains(rgb.color), (0...100).contains(rgb.brightness), (5...50).contains(rgb.speed10), (0...359).contains(rgb.hue) else { return nil }
        let ids = keys.flatMap { $0.flatMap { $0 } } + knob.map.flatMap { $0 }
        guard ids.allSatisfy({ (0...255).contains($0) }) else { return nil }
        var b = [UInt8](repeating: 0, count: 90); b[0] = 1; b[1] = UInt8(active)
        for p in 0..<2 { for k in 0..<9 { for i in 0..<3 { b[2 + p * 27 + k * 3 + i] = UInt8(keys[p][k][i]) } } }
        b[56] = UInt8(knob.mode); for m in 0..<6 { for i in 0..<4 { b[57 + m * 4 + i] = UInt8(knob.map[m][i]) } }
        b[81] = UInt8(rgb.effect); b[82] = UInt8(rgb.color); b[83] = UInt8(rgb.brightness); b[84] = UInt8(rgb.speed10); b[85] = UInt8(min(rgb.hue / 2, 179)); b[86] = UInt8(rev & 255)
        let c = DeviceConfig.crc16(b[0..<88]); b[88] = UInt8(c & 255); b[89] = UInt8(c >> 8); return b
    }
}

enum SyncError: Error { case notConnected, busy, timeout(String), device(String), conflict(DeviceConfig), verify(String), invalid(String)
    var text: String { switch self {
        case .notConnected: return "NU87 is not connected"
        case .busy: return "another sync is in progress"
        case .timeout(let s): return "timeout: \(s)"
        case .device(let s): return "device refused: \(s)"
        case .conflict: return "settings changed on the device since they were loaded"
        case .verify(let s): return "verification failed: \(s)"
        case .invalid(let s): return "invalid settings: \(s)" } }
}

/// Read / write of the device settings over the existing NUS link. All calls and callbacks run on the main queue.
/// Never retries a write silently after a failure and never replays anything after a reconnect.
final class DeviceSync {
    unowned let ble: BLEClient
    init(ble: BLEClient) { self.ble = ble }
    private(set) var busy = false
    private(set) var changeSeq = 0          // incremented for each device-side settings change (CCHG)
    private(set) var lastRev: Int?
    private var chunks: [Int: [UInt8]] = [:]
    private var onChunks: (() -> Void)?
    private var onAck: ((String) -> Void)?

    /// Feed every notified text. Returns true if it was a sync line.
    func handle(_ text: String) -> Bool {
        var any = false
        for raw in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            let line = String(raw)
            if line.hasPrefix("C|") {
                let f = line.split(separator: "|", omittingEmptySubsequences: false)
                if f.count == 3, let idx = Int(f[1], radix: 16), idx < 15, f[2].count == 12 {
                    var bytes = [UInt8](); var i = f[2].startIndex
                    while i < f[2].endIndex { let j = f[2].index(i, offsetBy: 2); if let v = UInt8(f[2][i..<j], radix: 16) { bytes.append(v) }; i = j }
                    if bytes.count == 6 { chunks[idx] = bytes; if chunks.count == 15 { onChunks?() } }
                }
                any = true
            } else if line.hasPrefix("CACK|") { onAck?(String(line.dropFirst(5))); any = true
            } else if line.hasPrefix("CCHG|") { changeSeq += 1; Log.shared.write("NU87: settings changed on device (\(line))"); any = true }
        }
        return any
    }

    func read(_ done: @escaping (Result<DeviceConfig, SyncError>) -> Void) {
        guard ble.isReady else { return done(.failure(.notConnected)) }
        guard !busy else { return done(.failure(.busy)) }
        busy = true; attemptRead(left: 3) { [weak self] r in self?.busy = false; if case .success(let c) = r { self?.lastRev = c.rev }; done(r) }
    }
    private func attemptRead(left: Int, _ done: @escaping (Result<DeviceConfig, SyncError>) -> Void) {
        chunks.removeAll(); var finished = false
        func finish(_ r: Result<DeviceConfig, SyncError>) { if finished { return }; finished = true; onChunks = nil; done(r) }
        onChunks = { [weak self] in
            guard let s = self else { return }
            let blob = (0..<15).flatMap { s.chunks[$0] ?? [] }
            if let c = DeviceConfig.decode(blob) { finish(.success(c)) } else { finish(.failure(.verify("CRC/format mismatch in data from device"))) }
        }
        guard ble.sendLine("CGET") else { return finish(.failure(.notConnected)) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let s = self, !finished else { return }
            if left > 1, s.ble.isReady { finished = true; s.onChunks = nil; s.attemptRead(left: left - 1, done); return }   // lost a chunk: re-request the whole blob (idempotent)
            finish(.failure(.timeout("device did not send settings (\(s.chunks.count)/15 chunks)")))
        }
    }

    /// base: the config the web editor loaded. If the device changed since (rev differs) → .conflict, nothing is written.
    func write(_ cfg: DeviceConfig, baseRev: Int, _ done: @escaping (Result<DeviceConfig, SyncError>) -> Void) {
        guard ble.isReady else { return done(.failure(.notConnected)) }
        guard !busy else { return done(.failure(.busy)) }
        guard cfg.encode() != nil else { return done(.failure(.invalid("value out of range"))) }
        busy = true
        func end(_ r: Result<DeviceConfig, SyncError>) { busy = false; if case .success(let c) = r { lastRev = c.rev }; done(r) }
        attemptRead(left: 2) { [weak self] r in
            guard let s = self else { return }
            switch r {
            case .failure(let e): end(.failure(e))
            case .success(let current):
                if current.rev != baseRev { return end(.failure(.conflict(current))) }
                var out = cfg; out.rev = current.rev
                guard let blob = out.encode() else { return end(.failure(.invalid("encode"))) }
                s.sendChunks(blob) { ok in
                    guard ok else { return end(.failure(.notConnected)) }
                    var acked = false
                    s.onAck = { code in
                        guard !acked else { return }; acked = true; s.onAck = nil
                        if code.hasPrefix("OK") {
                            s.attemptRead(left: 3) { rr in
                                switch rr {   // re-read and compare to what we asked for: the value the device really applied
                                case .failure(let e): end(.failure(.verify("saved but re-read failed: \(e.text)")))
                                case .success(let after): after == cfg ? end(.success(after)) : end(.failure(.verify("device returned different settings after save")))
                                }
                            }
                        } else {
                            let why = ["1": "chunks missing", "2": "CRC error", "3": "invalid value", "4": "device is busy (close Key Mapping / RGB screen on the NU87 and retry)", "5": "flash save failed"][String(code.split(separator: "|").last ?? "")] ?? code
                            end(.failure(.device(why)))
                        }
                    }
                    guard s.ble.sendLine("CCOM") else { s.onAck = nil; return end(.failure(.notConnected)) }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { if !acked { acked = true; s.onAck = nil; end(.failure(.timeout("no ACK from device; real state unknown, re-read to check"))) } }
                }
            }
        }
    }
    private func sendChunks(_ blob: [UInt8], _ done: @escaping (Bool) -> Void) {
        func send(_ i: Int) {
            if i == 15 { return done(true) }
            let hex = blob[(i * 6)..<(i * 6 + 6)].map { String(format: "%02X", $0) }.joined()
            guard ble.sendLine(String(format: "P|%02X|", i) + hex) else { return done(false) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.04) { send(i + 1) }
        }
        send(0)
    }
}
