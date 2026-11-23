import AppKit

// Usage: NU87Companion            menu-bar app
//        NU87Companion --run <id> run one action ID once and exit (no hardware needed)
//        NU87Companion --evt "EVT|1|1|S|2"  feed one event through the normal pipeline and exit
let args = CommandLine.arguments
if args.count >= 3 && args[1] == "--run", let id = Int(args[2]) {
    let r = ActionEngine.execute(id: id); print("action \(id): \(r.text)"); exit({ if case .ok = r { return 0 }; return 1 }())
}
if args.count >= 3 && args[1] == "--mime" { print(MIME.decode(args[2])); print("sender:", MIME.sender(args[2])); exit(0) }
if args.count >= 3 && args[1] == "--evt" {
    guard let e = KeyEvent.parse(args[2]) else { print("bad event"); exit(2) }
    let r = ActionEngine.execute(id: e.action, count: e.count); print("\(e.source) \(e.gestureName) action \(e.action) ×\(e.count): \(r.text)"); exit({ if case .ok = r { return 0 }; return 1 }())
}

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let ble = BLEClient()
    let exec = DispatchQueue(label: "nu87.exec")
    lazy var sync = DeviceSync(ble: ble)
    let api = LocalAPI()
    lazy var hub = NotifyHub(ble: ble)
    lazy var gmail = GmailClient(hub: hub)
    lazy var lunch = LunchService(ble: ble)
    lazy var gpt = GPTBridge(ble: ble)
    lazy var ai = AIHub(ble: ble)
    lazy var timeSync = TimeSync(ble: ble)
    lazy var weather = WeatherService(ble: ble, location: lunch.location)
    var state = "Starting…", connected = false, lastEvent = "—"
    var seen: [Int] = []   // recent sequence numbers; cleared on every (re)connect
    var window: NSWindow!, textView: NSTextView!, popup: NSPopUpButton!, showAll: NSButton!
    var shownIDs: [UUID] = [], autoPicked = false

    func applicationDidFinishLaunching(_ n: Notification) {
        Log.shared.write("NU87 Companion started")
        Keychain.preload()
        if !ActionEngine.accessibilityTrusted { ActionEngine.promptAccessibility() }
        Log.shared.onChange = { [weak self] in self?.refresh() }
        ble.onState = { [weak self] text, ok in
            guard let s = self else { return }
            if ok && !s.connected { s.seen.removeAll(); s.api.session += 1; DispatchQueue.main.asyncAfter(deadline: .now() + 2) { s.timeSync.send("connected"); s.weather.push(force: true); s.ai.syncToBoard(); UsageStore.shared.refreshCodex() }
                // the board is busy drawing for a few seconds after connecting and can drop lines: repeat the (tiny) weather / time state once it is idle
                for d in [9.0, 24.0] { DispatchQueue.main.asyncAfter(deadline: .now() + d) { s.weather.push(force: true); s.timeSync.send("connected") } } }
            s.state = text; s.connected = ok; Log.shared.write("BLE: \(text)"); s.refresh()
        }
        ble.onText = { [weak self] text in self?.handle(text) }
        ble.onDevices = { [weak self] in
            guard let s = self else { return }
            s.refreshDevices()
            // Test aid only: `--connect <id-prefix>` behaves as if the user had picked that device.
            if let i = CommandLine.arguments.firstIndex(of: "--connect"), i + 1 < CommandLine.arguments.count, !s.autoPicked,
               let d = s.ble.devices.values.first(where: { $0.id.uuidString.hasPrefix(CommandLine.arguments[i + 1].uppercased()) }) { s.autoPicked = true; s.ble.connect(to: d.id) }
        }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refreshDevices() }
        api.sync = sync; api.ble = ble; api.hub = hub; api.gmail = gmail; api.lunch = lunch; api.ai = ai; api.time = timeSync; api.weather = weather; timeSync.start(); weather.start(); ai.start(); AIHooks.refreshTrust(); Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in AIHooks.refreshTrust() }; api.start(); gmail.start()
        buildWindow(); refresh()
    }

    func handle(_ text: String) {
        if hub.handle(text) || lunch.handle(text) || gpt.handle(text) { return }
        if sync.handle(text) { return }
        guard let e = KeyEvent.parse(text) else { Log.shared.write("NU87: \(text.trimmingCharacters(in: .whitespacesAndNewlines))"); return }
        if seen.contains(e.seq) { Log.shared.write("duplicate EVT seq \(e.seq) ignored"); return }
        seen.append(e.seq); if seen.count > 32 { seen.removeFirst() }
        let head = "\(e.source) \(e.gestureName) action \(e.action)\(e.count > 1 ? " ×\(e.count)" : "") (seq \(e.seq))"
        let tRecv = Date()
        exec.async {
            let tStart = Date()
            let r = ActionEngine.execute(id: e.action, count: e.count)
            let tEnd = Date()
            if e.action == 54 || e.action == 55 { Log.shared.write(String(format: "REASONING_TIMING seq=%d queue_ms=%.0f exec_ms=%.0f (receipt -> keys posted)", e.seq, tStart.timeIntervalSince(tRecv) * 1000, tEnd.timeIntervalSince(tStart) * 1000)) }
            DispatchQueue.main.async {
                Log.shared.write("\(head): \(r.text)")
                self.lastEvent = "\(e.source) \(e.gestureName) → \(r.text)"; self.refresh()
                // Knob rotation is high-rate: acknowledge only problems so the board does not flash a toast per detent.
                if !e.isRotation || r.ackCode != "OK" { self.ble.sendAck(seq: e.seq, code: r.ackCode) }
                if e.action == 54 || e.action == 55 {   // visible feedback; only a value read back from the app is shown as the new level
                    let t = r.text; var toast = "Reasoning failed"
                    if r.ackCode == "OK" {
                        if t.contains("UNVERIFIED") { toast = "Sent (unverified)" }
                        else if let m = t.range(of: "reasoning (.+?) \\(", options: .regularExpression) { toast = "Reason: " + NotifyHub.clip(String(t[m]).replacingOccurrences(of: "reasoning ", with: "").replacingOccurrences(of: " (", with: ""), bytes: 10) }
                    } else if t.contains("frontmost") { toast = "ChatGPT not front" } else if r.ackCode == "UNSUP" { toast = "Unsupported" }
                    self.ble.sendLine("TS|" + toast); Log.shared.write("REASONING_CHANGE result=\(t)")
                }
            }
        }
    }

    // MARK: window (also usable when the menu bar is crowded or hidden by the notch)
    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 460), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "NU87 Companion"; window.isReleasedWhenClosed = false; window.center()
        let v = window.contentView!
        popup = NSPopUpButton(frame: NSRect(x: 10, y: 424, width: 560, height: 26)); popup.autoresizingMask = [.width, .minYMargin]
        popup.target = self; popup.action = #selector(popupChanged)
        showAll = NSButton(checkboxWithTitle: "Show all", target: self, action: #selector(refreshNow)); showAll.frame = NSRect(x: 580, y: 426, width: 90, height: 22); showAll.autoresizingMask = [.minXMargin, .minYMargin]
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 44, width: 760, height: 372)); scroll.autoresizingMask = [.width, .height]; scroll.hasVerticalScroller = true
        textView = NSTextView(frame: scroll.bounds); textView.isEditable = false; textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular); textView.autoresizingMask = [.width]
        scroll.documentView = textView
        [popup, showAll, scroll].forEach { v.addSubview($0) }
        var x = 10.0
        for (t, a) in [("Connect selected", #selector(connectSelected)), ("Forget Device", #selector(forget)), ("Reconnect", #selector(reconnect)), ("Grant Accessibility", #selector(grant)), ("Open Config", #selector(openConfig)), ("Open Log", #selector(openLog))] as [(String, Selector)] {
            let b = NSButton(title: t, target: self, action: a); b.frame = NSRect(x: x, y: 8, width: 118, height: 28); b.bezelStyle = .rounded; v.addSubview(b); x += 122
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// The popup is rebuilt only when the set of listed devices changes (so an open menu is not disturbed); titles update in place.
    func refreshDevices() {
        let list = ble.relevant(showAll: showAll.state == .on)
        let ids = list.map { $0.id }
        if ids != shownIDs {
            popup.removeAllItems()
            for d in list { popup.addItem(withTitle: d.title); popup.lastItem?.representedObject = d.id }
            if list.isEmpty { popup.addItem(withTitle: "Scanning… no NU87/NUS devices yet (tick Show all to see everything)") }
            shownIDs = ids
        } else { for (i, d) in list.enumerated() { popup.item(at: i)?.title = d.title } }
        // the user's selection survives list refreshes
        if let sel = ble.selectedID, let idx = shownIDs.firstIndex(of: sel) { popup.selectItem(at: idx) }
        refresh()
    }
    @objc func refreshNow() { shownIDs = []; refreshDevices() }
    @objc func popupChanged() { if let id = popup.selectedItem?.representedObject as? UUID { ble.selectedID = id } }
    @objc func connectSelected() { if let id = popup.selectedItem?.representedObject as? UUID { ble.connect(to: id) } }
    @objc func forget() { ble.forgetDevice() }

    func refresh() {
        let list = ble.relevant(showAll: showAll?.state == .on)
        let lines = ["BLE: \(state)", "Last: \(lastEvent)", "Accessibility: \(ActionEngine.accessibilityTrusted ? "granted" : "NOT granted (shortcuts/media will fail)")",
                     "Selected: \(ble.selectedID.map { String($0.uuidString.prefix(8)) } ?? "none")   Saved: \(ble.savedID.map { String($0.uuidString.prefix(8)) } ?? "none")", "",
                     "Devices (pick yours above, then Connect selected):"] + (list.isEmpty ? ["  (none yet)"] : list.prefix(20).map { "  " + $0.title }) + ["", "Log:"] + Log.shared.recent.map { "  " + $0 }
        textView?.string = lines.joined(separator: "\n")
        item.button?.title = connected ? "NU87 ●" : "NU87 ○"
        let m = NSMenu()
        func add(_ t: String, _ a: Selector? = nil) { let i = m.addItem(withTitle: t, action: a, keyEquivalent: ""); i.target = self; if a == nil { i.isEnabled = false } }
        add("BLE: \(state)"); add("Last: \(lastEvent)")
        add(ActionEngine.accessibilityTrusted ? "Accessibility: granted (shortcuts/media OK)" : "Accessibility: NOT granted (apps/URLs only)")
        m.addItem(.separator())
        if !ActionEngine.accessibilityTrusted { add("Grant Accessibility…", #selector(grant)) }
        add("Show Window", #selector(showWindow)); add("Reconnect", #selector(reconnect)); add("Forget Device", #selector(forget)); add("Open Log", #selector(openLog)); add("Open Config (action map)", #selector(openConfig))
        m.addItem(.separator()); add("Quit", #selector(quit))
        item.menu = m
    }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func grant() { ActionEngine.promptAccessibility() }
    @objc func reconnect() { ble.reconnect() }
    @objc func openLog() { NSWorkspace.shared.open(Log.path) }
    @objc func openConfig() { _ = Config.load(); NSWorkspace.shared.open(Config.url) }
    @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
