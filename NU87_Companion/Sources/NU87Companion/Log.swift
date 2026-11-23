import Foundation

final class Log {
    static let shared = Log()
    static let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/NU87Companion.log")
    private(set) var recent: [String] = []
    var onChange: (() -> Void)?
    private let df: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f }()

    func write(_ s: String) {
        let line = "\(df.string(from: Date())) \(s)"
        print(line); fflush(stdout)
        if let d = (line + "\n").data(using: .utf8) {
            if let h = try? FileHandle(forWritingTo: Log.path) { h.seekToEndOfFile(); h.write(d); try? h.close() }
            else { try? d.write(to: Log.path) }
        }
        DispatchQueue.main.async { self.recent.append(line); if self.recent.count > 8 { self.recent.removeFirst() }; self.onChange?() }
    }
}
