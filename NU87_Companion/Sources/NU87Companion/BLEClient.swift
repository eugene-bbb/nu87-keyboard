import CoreBluetooth

/// Parsed `EVT|seq|key|gesture|action[|count]` record. key 1-9 = switches (gesture S/D/H); key 0 = KNOB (gesture R=CW, L=CCW, C=click, H=hold).
/// `count` merges several rotation detents of the same direction into one event.
struct KeyEvent {
    let seq: Int, key: Int, gesture: String, action: Int, count: Int
    var isKnob: Bool { key == 0 }
    var isRotation: Bool { isKnob && (gesture == "R" || gesture == "L") }
    var source: String { isKnob ? "KNOB" : "SW\(key)" }
    var gestureName: String {
        switch gesture { case "S": return "SINGLE"; case "D": return "DOUBLE"; case "R": return "CW"; case "L": return "CCW"; case "C": return "CLICK"; default: return "HOLD" }
    }
    static func parse(_ text: String) -> KeyEvent? {
        guard let r = text.range(of: "EVT|") else { return nil }
        let f = text[r.lowerBound...].split(whereSeparator: { $0 == "\n" || $0 == "\r" }).first!.split(separator: "|").map(String.init)
        guard f.count == 5 || f.count == 6, let seq = Int(f[1]), let key = Int(f[2]), (0...9).contains(key), let act = Int(f[4]) else { return nil }
        let valid = key == 0 ? ["R", "L", "C", "H"] : ["S", "D", "H"]
        guard valid.contains(f[3]) else { return nil }
        let count = f.count == 6 ? (Int(f[5]) ?? 1) : 1
        return KeyEvent(seq: seq, key: key, gesture: f[3], action: act, count: max(1, min(count, 32)))
    }
}

/// What one advertised name looked like the last time it was heard under an identifier.
struct NameSighting { var last: Date; var rssi: Int; var services: [String] }

struct DeviceInfo {
    let id: UUID
    var peripheral: CBPeripheral
    var rssi: Int
    var lastSeen: Date                       // last real advertisement received (not a cache)
    var names: [String: NameSighting] = [:]  // every name heard under this identifier (advertised local name or peripheral.name per packet)
    var verdict = ""
    var current: String { names.max { $0.value.last < $1.value.last }?.key ?? "" }
    var advertisesNUS: Bool { names.values.contains { $0.services.contains(BLEClient.service.uuidString) } }
    /// Two different names alternating under ONE identifier means two physical boards share one Bluetooth address.
    var sharedWith: [String] { names.count > 1 ? names.keys.sorted() : [] }
    var age: Double { Date().timeIntervalSince(lastSeen) }
    var title: String {
        let n = current.isEmpty ? "(no name)" : current
        let ageText = age < 2 ? "live" : age < 60 ? "stale \(Int(age))s" : "stale >1min"
        let shared = sharedWith.isEmpty ? "" : " ⚠ names heard on this address: " + names.sorted { $0.value.last > $1.value.last }.map { "\($0.key) (\(Int(Date().timeIntervalSince($0.value.last)))s ago, \($0.value.rssi) dBm)" }.joined(separator: " / ")
        return "\(n) · \(rssi) dBm · \(ageText) · \(id.uuidString.prefix(8))\(advertisesNUS ? " · NUS" : "")\(shared)" + (verdict.isEmpty ? "" : " · \(verdict)")
    }
}

/// Connects only to the device the user picked (or the one verified earlier). After connecting it checks GATT
/// (NUS + RX/TX) and looks at the first traffic to tell the NU87 firmware from foreign NUS boards.
final class BLEClient: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let service = CBUUID(string: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
    static let rxUUID = CBUUID(string: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E") // Mac -> board (write)
    static let txUUID = CBUUID(string: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E") // board -> Mac (notify)
    static let savedKey = "savedDeviceIdentifier"
    /// Lines only the NU87 firmware produces (firmware_impl.h). Anything starting with "IT|" is another board's firmware.
    static let nu87Prefixes = ["BLE_ADDR", "EVT|", "SW", "INPUT_EVENT", "SCREEN_REQUEST", "RENDER_CANCEL", "DIRTY_PIXELS", "LCD_TRANSFER_US", "BOOT", "NVM_", "RGB_SAVE", "LCD_BENCH", "C|", "CACK|", "CCHG|", "CFG_", "KNOB_SAVE", "NACK|", "SPRITE", "LUNCH|", "GPT|"]
    static let maxAttempts = 6

    var onState: ((String, Bool) -> Void)?   // text, usable (verified NUS, not foreign)
    var onText: ((String) -> Void)?          // notifications from a device that is not foreign
    var onDevices: (() -> Void)?             // device table changed (throttled)
    private(set) var devices: [UUID: DeviceInfo] = [:]
    var selectedID: UUID?
    var savedID: UUID? { UserDefaults.standard.string(forKey: BLEClient.savedKey).flatMap(UUID.init) }
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var verified = false, foreign = false, confirmedNU87 = false
    private var attempts = 0
    private var lastPublish = Date.distantPast

    override init() { super.init(); central = CBCentralManager(delegate: self, queue: nil) }

    // MARK: user actions
    func connect(to id: UUID) {
        selectedID = id; attempts = 0
        guard let d = devices[id] else { return }
        devices[id]?.verdict = ""
        Log.shared.write("connect: user picked \(id.uuidString.prefix(8)) (\(d.current))")
        attempt(d.peripheral)
    }
    /// Forget only this app's remembered choice. macOS's own pairing data is never touched.
    func forgetDevice() {
        UserDefaults.standard.removeObject(forKey: BLEClient.savedKey)
        disconnectCurrent(); selectedID = nil
        for k in devices.keys { devices[k]?.verdict = "" }
        onState?("Saved device forgotten. Pick your NU87 from the list.", false); publish(force: true)
    }
    func reconnect() {
        guard let id = selectedID ?? savedID else { onState?("Pick your NU87 from the list", false); return }
        attempts = 0
        if let p = devices[id]?.peripheral ?? central.retrievePeripherals(withIdentifiers: [id]).first { attempt(p) }
    }

    // MARK: connection handling
    private func disconnectCurrent() {
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        peripheral = nil; rx = nil; verified = false; foreign = false; confirmedNU87 = false
    }
    private func attempt(_ p: CBPeripheral) {
        guard central.state == .poweredOn else { return }
        disconnectCurrent(); attempts += 1
        peripheral = p; p.delegate = self
        onState?("Connecting to \(p.identifier.uuidString.prefix(8)) (attempt \(attempts)/\(BLEClient.maxAttempts))…", false)
        central.connect(p, options: nil)
    }
    private func retryLater(_ p: CBPeripheral, why: String) {
        if attempts < BLEClient.maxAttempts {
            onState?("\(why); retrying (\(attempts)/\(BLEClient.maxAttempts))…", false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { if self.selectedID == p.identifier || self.savedID == p.identifier { self.attempt(p) } }
        } else { onState?("\(why); gave up after \(attempts) attempts. Use Connect selected to try again.", false) }
    }
    private func reject(_ p: CBPeripheral, _ why: String, retry: Bool) {
        devices[p.identifier]?.verdict = "✗ \(why)"
        Log.shared.write("rejected \(p.identifier.uuidString.prefix(8)): \(why)")
        central.cancelPeripheralConnection(p); if peripheral === p { peripheral = nil; rx = nil; verified = false }
        publish(force: true)
        if retry { retryLater(p, why: "Rejected: \(why)") } else { onState?("Rejected: \(why)", false) }
    }

    /// Execution result back to the board (toast). Never written to a foreign or unverified device.
    /// Settings-sync line (<= 20 bytes so it fits the default ATT MTU). Same safety rule as sendAck: only to a verified, non-foreign board.
    var isReady: Bool { verified && !foreign && rx != nil && peripheral?.state == .connected }
    var deviceLabel: String { peripheral.flatMap { devices[$0.identifier]?.current } ?? "" }
    var deviceIDPrefix: String { peripheral.map { String($0.identifier.uuidString.prefix(8)) } ?? "" }
    var isConfirmed: Bool { confirmedNU87 }
    @discardableResult func sendLine(_ line: String) -> Bool {
        guard isReady, let p = peripheral, let c = rx, let d = line.data(using: .utf8), d.count <= 20 else { return false }
        p.writeValue(d, for: c, type: c.properties.contains(.write) ? .withResponse : .withoutResponse); return true
    }
    func sendAck(seq: Int, code: String) {
        guard verified, !foreign, let p = peripheral, let c = rx, p.state == .connected, let d = "ACK,\(seq),\(code)".data(using: .utf8) else { return }
        p.writeValue(d, for: c, type: c.properties.contains(.write) ? .withResponse : .withoutResponse)
    }

    // MARK: scan bookkeeping
    private func startScan() { guard central.state == .poweredOn else { return }; central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: true]) }
    private func publish(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastPublish) > 1 else { return }
        lastPublish = Date(); onDevices?()
    }
    /// Devices worth showing: NU87/Penguin names, NUS advertisers, the selected/saved one, anything with a verdict.
    func relevant(showAll: Bool) -> [DeviceInfo] {
        devices.values.filter { d in
            if showAll || d.id == selectedID || d.id == savedID || !d.verdict.isEmpty || d.advertisesNUS { return true }
            return d.names.keys.contains { $0.lowercased().contains("nu87") || $0.lowercased().contains("penguin") }
        }.filter { $0.age < 60 || $0.id == selectedID || $0.id == savedID }
         .sorted { $0.rssi > $1.rssi }
    }

    // MARK: CBCentralManagerDelegate
    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        switch c.state {
        case .poweredOn:
            startScan()
            if let id = savedID, let p = c.retrievePeripherals(withIdentifiers: [id]).first { selectedID = id; attempts = 0; attempt(p) }
            else { onState?("Scanning. Pick your NU87 from the list.", false) }
        case .unauthorized: onState?("Bluetooth permission denied (System Settings → Privacy & Security → Bluetooth)", false)
        case .poweredOff: onState?("Bluetooth is off", false)
        default: onState?("Bluetooth unavailable", false)
        }
    }
    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi: NSNumber) {
        guard rssi.intValue != 127 else { return }
        let svcs = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []).map { $0.uuidString }
        let name = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? p.name ?? ""
        var d = devices[p.identifier] ?? DeviceInfo(id: p.identifier, peripheral: p, rssi: rssi.intValue, lastSeen: Date())
        d.peripheral = p; d.rssi = rssi.intValue; d.lastSeen = Date()
        if !name.isEmpty { var s = d.names[name] ?? NameSighting(last: Date(), rssi: rssi.intValue, services: []); s.last = Date(); s.rssi = rssi.intValue; for u in svcs where !s.services.contains(u) { s.services.append(u) }; d.names[name] = s }
        devices[p.identifier] = d
        publish()
    }
    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) { onState?("Connected, discovering GATT services…", false); p.discoverServices(nil) }
    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        guard peripheral === p else { return }
        let ns = error as NSError?
        // CBError.peerRemovedPairingInformation (14): this Mac holds an old bond the board no longer has. macOS normally drops the stale key
        // after reporting it, so a plain retry is the safe recovery. Nothing is deleted by this app.
        if ns?.domain == CBErrorDomain && ns?.code == CBError.peerRemovedPairingInformation.rawValue {
            Log.shared.write("connect \(p.identifier.uuidString.prefix(8)): stale pairing info on this Mac (CBError 14)")
            retryLater(p, why: "Stale pairing info on this Mac (macOS error 14)")
        } else { retryLater(p, why: "Connect failed: \(error?.localizedDescription ?? "unknown")") }
    }
    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard peripheral === p else { return }
        let wasUsable = verified && !foreign
        rx = nil; verified = false
        onState?("Disconnected\(error.map { ": \($0.localizedDescription)" } ?? "")\(wasUsable ? ", reconnecting…" : "")", false)
        // Only a usable (verified, non-foreign) device is retried; inputs made while away are never replayed.
        if wasUsable { attempts = 0; DispatchQueue.main.asyncAfter(deadline: .now() + 1) { if self.peripheral === p { self.attempt(p) } } } else { peripheral = nil }
    }

    // MARK: CBPeripheralDelegate (GATT verification + firmware identity)
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        if let e = error { reject(p, "service discovery error: \(e.localizedDescription)", retry: true); return }
        let found = (p.services ?? []).map { $0.uuid.uuidString }
        guard let s = p.services?.first(where: { $0.uuid == BLEClient.service }) else {
            reject(p, found.isEmpty ? "GATT has no services" : "no Nordic UART service; GATT has: \(found.joined(separator: ","))", retry: true); return
        }
        p.discoverCharacteristics([BLEClient.rxUUID, BLEClient.txUUID], for: s)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        if let e = error { reject(p, "characteristic discovery error: \(e.localizedDescription)", retry: true); return }
        let rxC = s.characteristics?.first { $0.uuid == BLEClient.rxUUID }, txC = s.characteristics?.first { $0.uuid == BLEClient.txUUID }
        guard let tx = txC, tx.properties.contains(.notify) else { reject(p, "NUS found but TX (…0003) notify characteristic missing", retry: false); return }
        rx = rxC
        if rxC == nil { Log.shared.write("warning: RX characteristic missing, ACKs disabled") }
        p.setNotifyValue(true, for: tx)
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor c: CBCharacteristic, error: Error?) {
        if c.isNotifying {
            verified = true; devices[p.identifier]?.verdict = "✓ NUS ok (waiting for traffic)"
            UserDefaults.standard.set(p.identifier.uuidString, forKey: BLEClient.savedKey)
            Log.shared.write("GATT ok on \(p.identifier.uuidString.prefix(8)): NUS service, TX notify\(rx == nil ? "" : ", RX write")")
            onState?("NUS verified on \(p.identifier.uuidString.prefix(8)); press a key on the NU87 to confirm it is your board", true); publish(force: true)
        } else if let e = error { reject(p, "could not enable notifications: \(e.localizedDescription)", retry: false) }
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor c: CBCharacteristic, error: Error?) {
        guard verified, c.uuid == BLEClient.txUUID, let d = c.value, let s = String(data: d, encoding: .utf8) else { return }
        if s.hasPrefix("IT|") {   // another board's firmware (e.g. 'Penguin'): drop it, never act on it
            if !foreign { foreign = true; reject(p, "foreign firmware on this address (sends \"\(s.prefix(12))…\"), not NU87", retry: true) }
            return
        }
        if !confirmedNU87, BLEClient.nu87Prefixes.contains(where: { s.hasPrefix($0) || s.contains("EVT|") }) {
            confirmedNU87 = true; devices[p.identifier]?.verdict = "✓ NU87 firmware confirmed"
            Log.shared.write("NU87 firmware confirmed on \(p.identifier.uuidString.prefix(8))")
            onState?("Connected to your NU87 (\(p.identifier.uuidString.prefix(8)))", true); publish(force: true)
        }
        onText?(s)
    }
}
