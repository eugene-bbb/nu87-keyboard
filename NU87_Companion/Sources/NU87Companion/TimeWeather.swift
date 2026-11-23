import Foundation
import CoreLocation
import AppKit

/// Wall-clock sync: the board keeps time with its own timer between syncs. Sent on connect / reconnect, every 10 min, when the Mac's time zone, DST offset or clock changes.
/// Line: CK|<local seconds since 1970, hex8>|<UTC offset minutes + 0x8000, hex4>|<1 = 12-hour display>   (local seconds = UTC seconds + offset)
final class TimeSync {
    unowned let ble: BLEClient
    private(set) var lastSent: Date?, lastOffset: Int?
    private var timer: Timer?, pending = false
    init(ble: BLEClient) { self.ble = ble }
    func start() {
        let c = NotificationCenter.default
        for n in [NSNotification.Name.NSSystemTimeZoneDidChange, .NSSystemClockDidChange, NSLocale.currentLocaleDidChangeNotification] { c.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in self?.send("system change") } }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let s = self else { return }
            let off = TimeZone.current.secondsFromGMT() / 60
            if off != s.lastOffset { s.send("UTC offset changed") } else if Date().timeIntervalSince(s.lastSent ?? .distantPast) > 600 { s.send("periodic") }
        }
    }
    var hour12: Bool { (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a") }
    /// Sent on the next whole second so the board starts counting within ~100 ms of the Mac's second tick.
    func send(_ why: String) {
        guard ble.isReady, !pending else { return }
        pending = true
        let frac = Date().timeIntervalSince1970.truncatingRemainder(dividingBy: 1)
        DispatchQueue.main.asyncAfter(deadline: .now() + (1 - frac)) { [weak self] in
            guard let s = self else { return }
            s.pending = false
            let now = Date(), off = TimeZone.current.secondsFromGMT(for: now) / 60
            let local = UInt32(max(0, (now.timeIntervalSince1970 + Double(off * 60)).rounded()))
            if s.ble.sendLine(String(format: "CK|%08X|%04X|%d", local, off + 0x8000, s.hour12 ? 1 : 0)) { s.lastSent = now; s.lastOffset = off; Log.shared.write("TIME_SYNC (\(why)) tz=\(TimeZone.current.identifier) offset_min=\(off)") }
        }
    }
    func status() -> [String: Any] {
        ["lastSync": lastSent.map { ISO8601DateFormatter().string(from: $0) } ?? "", "timeZone": TimeZone.current.identifier, "offsetMinutes": TimeZone.current.secondsFromGMT() / 60, "hour12": hour12, "boardConnected": ble.isReady]
    }
}

/// Current weather from Open-Meteo for the weather location (own setting, separate from the Lunch location). Never invents a value: failures keep the last data
/// with its age, and old data is sent to the board as "stale" (shown as --°).
final class WeatherService {
    struct Place: Codable { var name: String; var lat: Double; var lon: Double }
    struct Settings: Codable { var mode = "auto"; var custom: Place?
        static var url: URL { Config.url.deletingLastPathComponent().appendingPathComponent("weather.json") }
        static func load() -> Settings { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Settings.self, from: $0) } ?? Settings() }
        func save() { if let d = try? JSONEncoder().encode(self) { try? d.write(to: Settings.url, options: .atomic) } } }
    struct Current { var temp: Double; var code: Int; var isDay: Bool; var observed: Date; var fetched: Date; var place: Place }
    unowned let ble: BLEClient
    let location: LocationProvider
    private(set) var current: Current?, lastError = "", inFlight = false
    private var timer: Timer?, pushedSig = "", pushedName = "", searchCache = [Place](), lastFetchKey = ""
    static let freshSeconds: TimeInterval = 3600
    init(ble: BLEClient, location: LocationProvider) { self.ble = ble; self.location = location }
    var settings: Settings { get { Settings.load() } set { newValue.save() } }
    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            guard let s = self else { return }
            if Date().timeIntervalSince(s.current?.fetched ?? .distantPast) > 20 * 60 { s.refresh() }   // ~20 min refresh (failed fetches retry every minute at most this way)
            s.push()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.refresh() }
    }

    static func kind(code: Int, isDay: Bool) -> Int {
        switch code {
        case 0, 1: return isDay ? 0 : 1
        case 2: return isDay ? 2 : 3
        case 45, 48: return 4
        case 51...57, 61...67, 80...82: return 5
        case 71...77, 85, 86: return 6
        case 95...99: return 7
        default: return 3
        }
    }
    static func text(code: Int) -> String {
        switch code {
        case 0: return "Clear"; case 1: return "Mainly clear"; case 2: return "Partly cloudy"; case 3: return "Overcast"; case 45, 48: return "Fog"
        case 51...57: return "Drizzle"; case 61...67: return "Rain"; case 80...82: return "Rain showers"; case 71...77: return "Snow"; case 85, 86: return "Snow showers"; case 95...99: return "Thunderstorm"
        default: return "Code \(code)"
        }
    }

    private func resolve(_ done: @escaping (Place?) -> Void) {
        let s = settings
        if s.mode == "custom" { return done(s.custom) }
        location.get { [weak self] r in
            guard let self = self else { return }
            switch r {
            case .failure: done(s.custom)      // location unavailable: the saved place, otherwise none (no guessed city)
            case .success(let c):
                CLGeocoder().reverseGeocodeLocation(CLLocation(latitude: c.0, longitude: c.1)) { marks, _ in
                    let m = marks?.first; let name = [m?.locality, m?.subLocality].compactMap { $0 }.joined(separator: " ")
                    DispatchQueue.main.async { done(Place(name: name.isEmpty ? "현재 위치" : name, lat: c.0, lon: c.1)) }
                }
            }
        }
    }
    /// Asynchronous: never blocks the main thread or BLE handling.
    func refresh(force: Bool = false, _ done: (() -> Void)? = nil) {
        if inFlight { return }
        inFlight = true
        func end() { inFlight = false; push(); done?() }
        resolve { [weak self] place in
            guard let self = self else { return }
            guard let p = place else { self.lastError = "no weather location (location access denied and no saved place)"; return end() }
            var c = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
            c.queryItems = [.init(name: "latitude", value: String(p.lat)), .init(name: "longitude", value: String(p.lon)), .init(name: "current", value: "temperature_2m,weather_code,is_day"), .init(name: "timezone", value: "auto"), .init(name: "timeformat", value: "unixtime")]
            var r = URLRequest(url: c.url!); r.timeoutInterval = 12
            URLSession.shared.dataTask(with: r) { d, resp, e in DispatchQueue.main.async {
                guard let d = d, (resp as? HTTPURLResponse)?.statusCode == 200, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let cur = j["current"] as? [String: Any],
                      let t = (cur["temperature_2m"] as? NSNumber)?.doubleValue, let code = (cur["weather_code"] as? NSNumber)?.intValue, let ts = (cur["time"] as? NSNumber)?.doubleValue else {
                    self.lastError = e?.localizedDescription ?? "weather request failed"; Log.shared.write("WEATHER fetch failed: \(self.lastError)"); return end() }
                self.current = Current(temp: t, code: code, isDay: ((cur["is_day"] as? NSNumber)?.intValue ?? 1) == 1, observed: Date(timeIntervalSince1970: ts), fetched: Date(), place: p)
                self.lastError = ""; Log.shared.write("WEATHER ok code=\(code) temp=\(Int(t.rounded())) place=\(p.name)")
                end() } }.resume()
        }
    }

    /// Board state: WN|i|hex name chunks, then WS|kind|temp+64|f  (f: 1 fresh, 0 stale / unavailable, 2 no location configured)
    func push(force: Bool = false) {
        guard ble.isReady else { pushedSig = ""; return }
        let noLoc = current == nil && settings.custom == nil && settings.mode == "custom"
        let c = current, fresh = c.map { Date().timeIntervalSince($0.fetched) < WeatherService.freshSeconds } ?? false
        let f = fresh ? 1 : (c == nil && (noLoc || (settings.custom == nil && !lastError.isEmpty && lastError.hasPrefix("no weather location"))) ? 2 : 0)
        let kind = c.map { WeatherService.kind(code: $0.code, isDay: $0.isDay) } ?? 3
        let temp = max(0, min(127, Int((c?.temp ?? 0).rounded()) + 64))
        let name = NotifyHub.clip(c?.place.name ?? "", bytes: 24)
        let sig = "\(kind)|\(temp)|\(f)|\(name)"
        guard force || sig != pushedSig else { return }
        var lines = [String]()
        if force || name != pushedName { let b = Array(name.utf8); var i = 0, k = 0; repeat { lines.append(String(format: "WN|%d|", k) + b[min(i, b.count)..<min(i + 6, b.count)].map { String(format: "%02X", $0) }.joined()); i += 6; k += 1 } while i < b.count && k < 4 }
        lines.append(String(format: "WS|%d|%02X|%d", kind, temp, f))
        ble.sendLines(lines); pushedSig = sig; pushedName = name
    }

    func search(_ q: String, _ done: @escaping ([[String: Any]]?, String?) -> Void) {
        var c = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
        c.queryItems = [.init(name: "name", value: q), .init(name: "count", value: "6"), .init(name: "language", value: "ko"), .init(name: "format", value: "json")]
        var r = URLRequest(url: c.url!); r.timeoutInterval = 10
        URLSession.shared.dataTask(with: r) { [weak self] d, _, e in DispatchQueue.main.async {
            guard let d = d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return done(nil, e?.localizedDescription ?? "search failed") }
            let rs = (j["results"] as? [[String: Any]]) ?? []
            self?.searchCache = rs.compactMap { x in
                guard let n = x["name"] as? String, let la = (x["latitude"] as? NSNumber)?.doubleValue, let lo = (x["longitude"] as? NSNumber)?.doubleValue else { return nil }
                let detail = [x["admin1"] as? String, x["country"] as? String].compactMap { $0 }.joined(separator: ", ")
                return Place(name: detail.isEmpty ? n : "\(n) (\(detail))", lat: la, lon: lo) }
            done(self?.searchCache.enumerated().map { ["id": $0.offset, "name": $0.element.name, "lat": ($0.element.lat * 100).rounded() / 100, "lon": ($0.element.lon * 100).rounded() / 100] } ?? [], nil) } }.resume()
    }
    func select(_ id: Int) -> Bool {
        guard searchCache.indices.contains(id) else { return false }
        var s = settings; var p = searchCache[id]; p.name = NotifyHub.clip(p.name.components(separatedBy: " (").first ?? p.name, bytes: 24); s.custom = p; s.mode = "custom"; settings = s; current = nil; return true
    }
    func status() -> [String: Any] {
        let s = settings; var out: [String: Any] = ["mode": s.mode, "locationPermission": location.statusText, "inFlight": inFlight, "lastError": lastError, "source": "Open-Meteo (open-meteo.com)"]
        if let p = s.custom { out["custom"] = ["name": p.name, "lat": (p.lat * 100).rounded() / 100, "lon": (p.lon * 100).rounded() / 100] }
        if let c = current {
            let age = Int(Date().timeIntervalSince(c.fetched))
            out["current"] = ["temp": Int(c.temp.rounded()), "code": c.code, "condition": WeatherService.text(code: c.code), "isDay": c.isDay, "observed": ISO8601DateFormatter().string(from: c.observed), "fetched": ISO8601DateFormatter().string(from: c.fetched), "ageSeconds": age,
                              "fresh": Double(age) < WeatherService.freshSeconds, "place": c.place.name, "lat": (c.place.lat * 100).rounded() / 100, "lon": (c.place.lon * 100).rounded() / 100]
        }
        return out
    }
}
