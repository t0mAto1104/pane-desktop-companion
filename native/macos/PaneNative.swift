
import AppKit
import CoreGraphics
import Darwin

struct NativeFailure: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

func write(_ data: Data) { FileHandle.standardOutput.write(data) }

func sendJSON(_ object: Any) throws {
    var data = try JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])
    data.append(10)
    write(data)
}

func rectJSON(_ rect: CGRect) -> [String: Int] {
    let pixels = rect.integral
    return ["x": Int(pixels.minX), "y": Int(pixels.minY),
            "width": Int(pixels.width), "height": Int(pixels.height)]
}

func validRect(_ rect: CGRect) -> Bool {
    [rect.minX, rect.minY, rect.width, rect.height].allSatisfy(\.isFinite)
        && abs(rect.minX) < 100_000 && abs(rect.minY) < 100_000
        && rect.width > 0 && rect.height > 0 && rect.width <= 30_000 && rect.height <= 30_000
}

@main struct PaneNative {
    @MainActor static func main() async {
        do {
            try await run(Array(CommandLine.arguments.dropFirst()))
        } catch {
            let code = (error as? NativeFailure)?.code ?? "native_failed"
            FileHandle.standardError.write(Data((code + "\n").utf8))
            exit(1)
        }
    }

    @MainActor private static func run(_ arguments: [String]) async throws {
        guard arguments.count >= 2, let assistant = pid_t(arguments[1]), assistant > 0 else {
            throw NativeFailure("invalid_arguments")
        }
        let args = Array(arguments.dropFirst(2))
        let desktop = MacDesktop(assistant: assistant)
        switch arguments[0] {
        case "self-check":
            try sendJSON(["platform": "darwin", "protocol": 1] as [String: Any])
        case "screen-permission":
            try sendJSON(CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess())
        case "foreground":
            try sendJSON(try desktop.foreground(args).json)
        case "list":
            try sendJSON(try desktop.list(args).map(\.json))
        case "selection":
            let target = try desktop.foreground(args)
            let selection = try MacAccessibility.selection(target)
            let latest = try desktop.foreground(args)
            guard latest.id == target.id, latest.bounds == target.bounds else { throw NativeFailure("target_gone") }
            try sendJSON(["target": target.json, "selection": selection] as [String: Any])
        case "selection-watch":
            MacSelectionWatch(desktop: desktop, denied: args).run()
        case "credential":
            try promptKey()
        case "audio-list":
            try sendJSON(MacAudio.list())
        case "audio-record":
            try MacAudio.record(args.first ?? "")
        case "audio-preview", "audio-play":
            try MacAudio.play(args.first ?? "", preview: arguments[0] == "audio-preview")
        case "audio-speak":
            try MacAudio.speak(args.first ?? "")
        case "verify", "geometry", "uia", "capture", "roi", "observe":
            guard args.count >= 3, args[1] == "--expected-executable" else {
                throw NativeFailure("invalid_arguments")
            }
            let roi = arguments[0] == "roi"
            let denied = Array(args.dropFirst(roi ? 7 : 3))
            let verified = { try desktop.verify(args[0], executable: args[2], denied: denied) }
            let target = try verified()
            switch arguments[0] {
            case "verify": try sendJSON(target.json)
            case "geometry": try sendJSON(target.geometry)
            case "uia":
                let tree = try MacAccessibility.inspect(target)
                guard try verified().bounds == target.bounds else { throw NativeFailure("resized") }
                try sendJSON(["geometry": target.geometry, "tree": tree])
            case "capture", "roi", "observe":
                let capture = MacCapture(verify: verified)
                if roi {
                    let values = args.dropFirst(3).prefix(4).compactMap(Int.init)
                    guard values.count == 4 else { throw NativeFailure("roi_invalid") }
                    try await capture.region(values)
                } else if arguments[0] == "observe" {
                    try await capture.observe()
                } else {
                    let frame = try await capture.frame()
                    let jpeg = try MacCapture.jpeg(frame.image)
                    _ = try verified()
                    try sendJSON(frame.target.json)
                    write(jpeg)
                }
            default: break
            }
        default:
            throw NativeFailure("invalid_arguments")
        }
    }

    @MainActor private static func promptKey() throws {
        guard MacDesktop.sessionAvailable else { throw NativeFailure("desktop_locked") }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "OpenAI API Key"
        alert.informativeText = "密钥将写入 Pane 的加密存储。"
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "取消")
        let input = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 25))
        input.maximumNumberOfLines = 1
        alert.accessoryView = input
        alert.window.initialFirstResponder = input
        guard alert.runModal() == .alertFirstButtonReturn else { throw NativeFailure("key_cancelled") }
        write(Data(input.stringValue.utf8))
        input.stringValue = ""
    }
}
