import Foundation
import CoreLocation
import AppKit

/// Random lunch pick near the workplace from REAL Kakao Local search results (category FD6 within a radius). No ratings, hours or reviews are invented:
/// it is "random nearby restaurant", not "best restaurant". Coordinates stay in lunch.json on this Mac; the REST key stays in the Keychain.
struct LunchSettings: Codable {
    var radius = 1000, categories: [String] = [], excludeRecent = 10, useCurrentLocation = false, mapProvider = "kakao"
    var workLabel = "", workLat: Double?, workLon: Double?, recent: [String] = []
    static var url: URL { Config.url.deletingLastPathComponent().appendingPathComponent("lunch.json") }
    static func load() -> LunchSettings { (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(LunchSettings.self, from: $0) } ?? LunchSettings() }
    func save() { if let d = try? JSONEncoder().encode(self) { try? d.write(to: LunchSettings.url, options: .atomic) } }
}
struct Place { var id: String, name: String, category: String, address: String, url: String, distance: Int }
enum LunchError: Error { case permission, noLocation, noKey, api(String), offline, empty
    var code: Int { switch self { case .permission: return 1; case .noLocation: return 2; case .noKey: return 3; case .api: return 4; case .offline: return 5; case .empty: return 6 } }
    var reason: String { switch self { case .permission, .noLocation: return "NO_LOCATION"; case .noKey, .api, .offline: return "API_ERROR"; case .empty: return "NO_RESULTS" } }
    var text: String { switch self { case .permission: return "location permission denied"; case .noLocation: return "no work location set"; case .noKey: return "Kakao REST API key missing"
        case .api(let s): return "search failed: \(s)"; case .offline: return "offline"; case .empty: return "no restaurants in range" } }
}

final class LocationProvider: NSObject, CLLocationManagerDelegate {
    private let mgr = CLLocationManager(); private var waiting: ((Result<(Double, Double), LunchError>) -> Void)?
    override init() { super.init(); mgr.delegate = self; mgr.desiredAccuracy = kCLLocationAccuracyHundredMeters }
    var statusText: String { switch mgr.authorizationStatus { case .notDetermined: return "not asked"; case .denied: return "denied"; case .restricted: return "restricted"; default: return "allowed" } }
    private var cached: (c: (Double, Double), at: Date)?
    /// Never makes the search wait for a permission dialog: undecided/denied -> immediate failure (the caller falls back to the work location).
    func get(_ done: @escaping (Result<(Double, Double), LunchError>) -> Void) {
        if let c = cached, Date().timeIntervalSince(c.at) < 600 { return done(.success(c.c)) }
        guard CLLocationManager.locationServicesEnabled() else { return done(.failure(.permission)) }
        switch mgr.authorizationStatus {
        case .notDetermined: mgr.requestWhenInUseAuthorization(); return done(.failure(.permission))
        case .denied, .restricted: return done(.failure(.permission))
        default: break
        }
        waiting = done; mgr.requestLocation()
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.finish(.failure(.permission)) }
    }
    private func finish(_ r: Result<(Double, Double), LunchError>) { if case .success(let c) = r { cached = (c, Date()) }; let w = waiting; waiting = nil; w?(r) }
    func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        guard waiting != nil else { return }
        switch m.authorizationStatus { case .notDetermined: break; case .denied, .restricted: finish(.failure(.permission)); default: m.requestLocation() }
    }
    func locationManager(_ m: CLLocationManager, didUpdateLocations l: [CLLocation]) { if let c = l.last?.coordinate { finish(.success((c.latitude, c.longitude))) } }
    func locationManager(_ m: CLLocationManager, didFailWithError e: Error) { finish(.failure((e as? CLError)?.code == .denied ? .permission : .api(e.localizedDescription))) }
}

final class LunchService {
    unowned let ble: BLEClient
    let location = LocationProvider()
    private var current: Place?, gen = 0
    init(ble: BLEClient) { self.ble = ble }
    var settings: LunchSettings { get { LunchSettings.load() } set { newValue.save() } }
    var hasKey: Bool { Keychain.get("kakao_rest_key") != nil }
    func setKey(_ k: String) { Keychain.set("kakao_rest_key", k.trimmingCharacters(in: .whitespacesAndNewlines)) }
    func status() -> [String: Any] {
        let s = settings
        return ["radius": s.radius, "categories": s.categories, "excludeRecent": s.excludeRecent, "useCurrentLocation": s.useCurrentLocation, "mapProvider": s.mapProvider,
                "workLabel": s.workLabel, "hasWorkLocation": s.workLat != nil, "hasKey": hasKey, "keychainReady": Keychain.isLoaded, "locationPermission": location.statusText, "recentCount": s.recent.count]
    }

    // MARK: Kakao Local
    private func kakao(_ path: String, _ q: [String: String], _ done: @escaping (Result<[String: Any], LunchError>) -> Void) {
        guard let key = Keychain.get("kakao_rest_key") else { return done(.failure(.noKey)) }
        var c = URLComponents(string: "https://dapi.kakao.com/v2/local/\(path)")!; c.queryItems = q.map { URLQueryItem(name: $0.key, value: $0.value) }
        var r = URLRequest(url: c.url!); r.setValue("KakaoAK \(key)", forHTTPHeaderField: "Authorization"); r.timeoutInterval = 12
        URLSession.shared.dataTask(with: r) { d, resp, e in DispatchQueue.main.async {
            if let e = e as? URLError { return done(.failure([.notConnectedToInternet, .networkConnectionLost, .dnsLookupFailed, .cannotFindHost].contains(e.code) ? .offline : .api(e.localizedDescription))) }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 401 || code == 403 {   // the key exists (it is in the Keychain): report what Kakao actually said
                let msg = d.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }.flatMap { $0["message"] as? String } ?? ""
                return done(.failure(.api("Kakao \(code): \(msg.isEmpty ? "rejected" : msg)" + (code == 401 ? " — use the REST API key" : " — enable the Kakao Map / Local service for this app"))))
            }
            guard code == 200, let d = d, let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return done(.failure(.api("HTTP \(code)"))) }
            done(.success(j)) } }.resume()
    }
    /// Work location from an address/place query (Kakao keyword search); only the label is returned to the web, never the coordinates.
    func setWorkplace(query: String, done: @escaping (Result<String, LunchError>) -> Void) {
        kakao("search/keyword.json", ["query": query, "size": "1"]) { [weak self] r in
            switch r {
            case .failure(let e): done(.failure(e))
            case .success(let j):
                guard let d = (j["documents"] as? [[String: Any]])?.first, let x = Double(d["x"] as? String ?? ""), let y = Double(d["y"] as? String ?? "") else { return done(.failure(.empty)) }
                var s = self!.settings; s.workLat = y; s.workLon = x; s.workLabel = (d["place_name"] as? String ?? query) + " · " + (d["address_name"] as? String ?? ""); s.recent = []; self!.settings = s
                done(.success(s.workLabel))
            }
        }
    }
    private func resolveCenter(_ done: @escaping (Result<(Double, Double), LunchError>) -> Void) {
        let s = settings
        func work() { if let a = s.workLat, let b = s.workLon { done(.success((a, b))) } else { done(.failure(.noLocation)) } }
        if s.useCurrentLocation { location.get { r in if case .success = r { done(r) } else if s.workLat != nil { work() } else { done(r) } } } else { work() }
    }
    private func search(lat: Double, lon: Double, _ done: @escaping (Result<[Place], LunchError>) -> Void) {
        let s = settings; var all = [Place](), seen = Set<String>()
        func page(_ n: Int) {
            kakao("search/category.json", ["category_group_code": "FD6", "x": String(lon), "y": String(lat), "radius": String(s.radius), "size": "15", "page": String(n), "sort": "distance"]) { r in
                switch r {
                case .failure(let e): all.isEmpty ? done(.failure(e)) : done(.success(all))
                case .success(let j):
                    for d in (j["documents"] as? [[String: Any]]) ?? [] {
                        guard let id = d["id"] as? String, seen.insert(id).inserted, let name = d["place_name"] as? String else { continue }
                        let parts = (d["category_name"] as? String ?? "").components(separatedBy: " > ")
                        let cat = parts.count > 1 ? parts[1] : "음식점"
                        all.append(Place(id: id, name: name, category: cat, address: (d["road_address_name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? d["address_name"] as? String ?? "",
                                         url: d["place_url"] as? String ?? "", distance: Int(d["distance"] as? String ?? "") ?? 0))
                    }
                    let end = ((j["meta"] as? [String: Any])?["is_end"] as? Bool) ?? true
                    if end || n >= 3 { done(.success(all)) } else { page(n + 1) }
                }
            }
        }
        page(1)
    }
    static let mains = ["한식", "중식", "일식", "양식", "분식"]
    /// Mirror radius / food filter to the keyboard (LC|r|c: radius index, food 0 all, 1-5 single, 9 several).
    func pushSettings() {
        let st = settings, r = [500, 1000, 2000, 3000].firstIndex(of: st.radius) ?? 1
        let c = st.categories.isEmpty ? 0 : (st.categories.count == 1 ? (LunchService.mains.firstIndex(of: st.categories[0]).map { $0 + 1 } ?? 9) : 9)
        ble.sendLines(["LC|\(r)|\(c)"])
    }
    private static let mainCats: Set<String> = ["한식", "중식", "일식", "양식", "분식", "아시아음식", "패스트푸드"]
    /// Real search + random choice, avoiding recently picked places.
    func roll(_ done: @escaping (Result<Place, LunchError>) -> Void) {
        gen += 1; let my = gen          // latest request wins: older in-flight searches are dropped when they finish
        guard hasKey else { return done(.failure(.noKey)) }
        func end(_ r: Result<Place, LunchError>) { if my == self.gen { done(r) } else { Log.shared.write("LUNCH_STALE dropped an outdated search result") } }
        resolveCenter { [weak self] c in
            guard let s = self else { return }
            switch c {
            case .failure(let e): end(.failure(e))
            case .success(let (lat, lon)):
                s.search(lat: lat, lon: lon) { r in
                    switch r {
                    case .failure(let e): end(.failure(e))
                    case .success(var places):
                        let st = s.settings
                        if !st.categories.isEmpty { places = places.filter { st.categories.contains($0.category) || (st.categories.contains("기타") && !LunchService.mainCats.contains($0.category)) } }
                        let recent = Set(st.recent.suffix(st.excludeRecent))
                        let fresh = places.filter { !recent.contains($0.id) }
                        guard let pick = (fresh.isEmpty ? places : fresh).randomElement() else { return end(.failure(.empty)) }
                        s.current = pick; end(.success(pick))
                    }
                }
            }
        }
    }
    func confirm() { guard let p = current else { return }; var s = settings; s.recent.append(p.id); s.recent = Array(s.recent.suffix(60)); settings = s; Log.shared.write("Lunch confirmed: \(p.name)") }
    func openMap() -> Bool {
        guard let p = current else { return false }
        var u: URL?
        if settings.mapProvider == "naver" { u = URL(string: "https://map.naver.com/p/search/" + (p.name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? "")) }
        else if let c = URL(string: p.url), c.scheme == "https" || c.scheme == "http", (c.host ?? "").hasSuffix("kakao.com") { u = c }
        guard let url = u else { return false }
        return NSWorkspace.shared.open(url)
    }
    static func json(_ p: Place) -> [String: Any] { ["name": p.name, "category": p.category, "distance": p.distance, "address": p.address, "mapUrl": p.url] }

    // MARK: board
    func handle(_ text: String) -> Bool {
        var any = false
        for l in text.split(whereSeparator: { $0 == "\n" || $0 == "\r" }) where l.hasPrefix("LUNCH|") {
            any = true
            switch l.dropFirst(6) {
            case _ where l.hasPrefix("LUNCH|ROLL"):
                let f = l.split(separator: "|").map(String.init); let id = f.count >= 3 ? (UInt8(f[2], radix: 16) ?? 0) : 0
                Log.shared.write(String(format: "LUNCH_REQ id=%d", id)); pushSettings(); rollToBoard(id: id)
            case "CONFIRM": confirm()
            case "MAP": Log.shared.write(openMap() ? "Lunch: map opened on Mac" : "Lunch: no map to open")
            default:
                let f = l.split(separator: "|").map(String.init)   // LUNCH|SET|R|n (radius) or LUNCH|SET|C|n (food filter) from the keyboard
                if f.count == 4, f[1] == "SET", let n = Int(f[3]) {
                    var st = settings
                    if f[2] == "R", [0, 1, 2, 3].contains(n) { st.radius = [500, 1000, 2000, 3000][n] }
                    if f[2] == "C", (0...5).contains(n) { st.categories = n == 0 ? [] : [LunchService.mains[n - 1]] }
                    settings = st; Log.shared.write("Lunch setting changed on NU87: \(f[2]) \(n)"); pushSettings()
                }
            }
        }
        return any
    }
    /// Sends one result to the board's Lunch screen (LB / LF fields / LR commit).
    func pushPlace(_ p: Place, id: UInt8 = 0) {
        let tag = String(format: "%02X", id)
        func hex(_ str: String, _ cap: Int, _ k: Int) -> [String] { let b = Array(NotifyHub.clip(str, bytes: cap).utf8); var out = [String](), i = 0; while i < b.count { out.append("LF|\(k)|" + b[i..<min(i + 6, b.count)].map { String(format: "%02X", $0) }.joined()); i += 6 }; return out }
        let n = NotifyHub.clip(p.name, bytes: 50), c = NotifyHub.clip(p.category, bytes: 18), a = NotifyHub.clip(p.address, bytes: 50)
        ble.sendLines(["LB|\(tag)"] + hex(p.name, 50, 0) + hex(p.category, 18, 1) + hex(p.address, 50, 2)
                      + [String(format: "LR|%02X|%02X|%02X|%04X|", n.utf8.count, c.utf8.count, a.utf8.count, min(p.distance, 65535)) + tag])
    }
    func rollToBoard(id: UInt8) {
        let t0 = Date(), tag = String(format: "%02X", id)
        ble.sendLines(["LS|s|\(tag)"]); Log.shared.write(String(format: "LUNCH_ACK id=%d (searching)", id))   // immediate ACK: the board stops its no-response timer
        Log.shared.write(String(format: "LUNCH_SEARCH id=%d", id))
        roll { [weak self] r in
            guard let s = self else { return }
            switch r {
            case .failure(let e):
                Log.shared.write(String(format: "LUNCH_ERROR id=%d reason=%@ (%@) after %.1fs", id, e.reason, e.text, Date().timeIntervalSince(t0)))
                if !s.ble.sendLine(String(format: "LS|e|%02X|", e.code) + tag) { Log.shared.write(String(format: "LUNCH_ERROR id=%d reason=BLE_ERROR (board unreachable)", id)) }
            case .success(let p):
                Log.shared.write(String(format: "LUNCH_RESULT id=%d %@ (%d m) in %.1fs, sending to board", id, "ok", p.distance, Date().timeIntervalSince(t0)))
                s.pushPlace(p, id: id)
            }
        }
    }
}
