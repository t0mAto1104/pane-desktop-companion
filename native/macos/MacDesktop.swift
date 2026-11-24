
import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct MacTarget {
    let window: CGWindowID
    let pid: pid_t
    let started: UInt64
    let executable: String
    let title: String
    let bounds: CGRect
    let foreground: Bool
    let visible: Bool
    let protected: Bool

    var id: String { "\(window):\(pid):\(started)" }
    var json: [String: Any] { ["id": id, "title": title, "executable": executable] }
    // Quartz and AX use global logical points. Frame dimensions are reported independently in pixels.
    var geometry: [String: Any] { ["bounds": rectJSON(bounds), "dpi": 96, "foreground": foreground] }
}

@MainActor struct MacDesktop {
    let assistant: pid_t
    private static let excluded: Set<String> = [
        "local.pane.desktop-companion", "com.apple.loginwindow", "com.apple.securityagent",
        "com.apple.keychainaccess", "com.apple.passwords", "com.apple.authenticationservicesui",
        "com.1password.1password", "com.1password.1password7", "org.keepassxc.keepassxc",
    ]

    static var sessionAvailable: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
              session[kCGSessionOnConsoleKey as String] as? Bool == true else { return false }
        return session["CGSSessionScreenIsLocked"] as? Bool != true
    }

    private func checkSession() throws {
        guard Self.sessionAvailable else { throw NativeFailure("desktop_locked") }
    }

    private func windows(_ options: CGWindowListOption) -> [MacTarget] {
        guard let rows = CGWindowListCopyWindowInfo([options, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return [] }
        let foregroundPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var results: [MacTarget] = []
        for row in rows {
            guard (row[kCGWindowLayer as String] as? Int) == 0,
                  let window = row[kCGWindowNumber as String] as? UInt32,
                  let pid = row[kCGWindowOwnerPID as String] as? Int32,
                  pid != assistant, pid != getpid(),
                  let app = NSRunningApplication(processIdentifier: pid),
                  app.activationPolicy == .regular,
                  let launchDate = app.launchDate,
                  let name = app.bundleIdentifier ?? app.executableURL?.lastPathComponent,
                  let raw = row[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary),
                  validRect(bounds), bounds.width >= 64, bounds.height >= 48 else { continue }
            let started = UInt64(launchDate.timeIntervalSince1970 * 1_000_000)
            let caption = (row[kCGWindowName as String] as? String).flatMap { $0.isEmpty ? nil : $0 }
            let title = caption ?? app.localizedName ?? name
            let visible = row[kCGWindowIsOnscreen as String] as? Bool == true
            let protected = (row[kCGWindowSharingState as String] as? Int) == Int(CGWindowSharingType.none.rawValue)
            let front = foregroundPID == pid && visible && !results.contains { $0.pid == pid && $0.visible }
            results.append(MacTarget(window: window, pid: pid, started: started, executable: name,
                                     title: String(title.prefix(200)), bounds: bounds.integral,
                                     foreground: front, visible: visible, protected: protected))
        }
        return results
    }

    private func allowed(_ target: MacTarget, _ denied: [String]) throws -> MacTarget {
        let name = target.executable.lowercased()
        guard !Self.excluded.contains(name), !denied.contains(where: { $0.lowercased() == name }) else {
            throw NativeFailure("blocked")
        }
        guard !target.protected else { throw NativeFailure("protected") }
        guard target.visible else { throw NativeFailure("minimized") }
        return target
    }

    func list(_ denied: [String]) throws -> [MacTarget] {
        try checkSession()
        return Array(windows(.optionOnScreenOnly).compactMap { try? allowed($0, denied) }.prefix(150))
    }

    func foreground(_ denied: [String]) throws -> MacTarget {
        try checkSession()
        guard let target = windows(.optionOnScreenOnly).first(where: \.foreground) else {
            throw NativeFailure("no_target")
        }
        return try allowed(target, denied)
    }

    func verify(_ id: String, executable: String, denied: [String]) throws -> MacTarget {
        try checkSession()
        guard let target = windows(.optionAll).first(where: { $0.id == id }),
              target.executable.caseInsensitiveCompare(executable) == .orderedSame else {
            throw NativeFailure("target_gone")
        }
        return try allowed(target, denied)
    }
}

@MainActor final class MacCapture {
    typealias Frame = (image: CGImage, target: MacTarget)
    private let verify: () throws -> MacTarget
    private var filter: SCContentFilter?
    private var filterBounds: CGRect?

    init(verify: @escaping () throws -> MacTarget) { self.verify = verify }

    func frame() async throws -> Frame {
        let target = try verify()
        guard CGPreflightScreenCaptureAccess() else { throw NativeFailure("screen_permission") }
        if filter == nil || filterBounds != target.bounds {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
            guard let window = content.windows.first(where: { $0.windowID == target.window && $0.owningApplication?.processID == target.pid }) else {
                throw NativeFailure("target_gone")
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            filterBounds = target.bounds
        }
        guard let filter else { throw NativeFailure("no_frame") }
        let config = SCStreamConfiguration()
        // Match the physical resolution of the monitor containing most of the window.
        let scale = CGFloat(filter.pointPixelScale)
        config.width = Int((target.bounds.width * scale).rounded())
        config.height = Int((target.bounds.height * scale).rounded())
        guard config.width > 0, config.height > 0, config.width <= 9_000, config.height <= 9_000,
              config.width * config.height <= 25_000_000 else { throw NativeFailure("invalid_size") }
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image: CGImage
        do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
        catch { throw NativeFailure(CGPreflightScreenCaptureAccess() ? "no_frame" : "screen_permission") }
        guard try verify().bounds == target.bounds else { throw NativeFailure("resized") }
        return (image, target)
    }

    static func jpeg(_ image: CGImage) throws -> Data {
        let bytes = NSMutableData()
        guard let output = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw NativeFailure("no_frame")
        }
        CGImageDestinationAddImage(output, image, [kCGImageDestinationLossyCompressionQuality: 0.88] as CFDictionary)
        guard CGImageDestinationFinalize(output), bytes.length < 12 * 1024 * 1024 else {
            throw NativeFailure("image_too_large")
        }
        return bytes as Data
    }

    func region(_ units: [Int]) async throws {
        guard units.allSatisfy({ (0...1_000_000).contains($0) }),
              units[2] > 0, units[3] > 0,
              units[0] + units[2] <= 1_000_000, units[1] + units[3] <= 1_000_000 else {
            throw NativeFailure("roi_invalid")
        }
        let frame = try await frame()
        let width = CGFloat(frame.image.width)
        let height = CGFloat(frame.image.height)
        let crop = CGRect(x: CGFloat(units[0]) * width / 1_000_000,
                          y: CGFloat(units[1]) * height / 1_000_000,
                          width: CGFloat(units[2]) * width / 1_000_000,
                          height: CGFloat(units[3]) * height / 1_000_000).integral
        guard crop.width * crop.height <= 12_000_000 else { throw NativeFailure("roi_too_large") }
        guard let image = frame.image.cropping(to: crop) else { throw NativeFailure("roi_invalid") }
        let bytes = try Self.jpeg(image)
        guard try verify().bounds == frame.target.bounds else { throw NativeFailure("resized") }
        try sendJSON(["target": frame.target.json, "geometry": frame.target.geometry, "pixels": rectJSON(crop),
                      "frameSize": ["width": frame.image.width, "height": frame.image.height]])
        write(bytes)
    }

    private func sample(_ image: CGImage) throws -> Data {
        let width = 96, height = 54
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = rgba.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else { throw NativeFailure("no_frame") }
        var data = Data(capacity: width * height * 3)
        for offset in stride(from: 0, to: rgba.count, by: 4) { data.append(contentsOf: rgba[offset..<(offset + 3)]) }
        return data
    }

    func observe() async throws {
        var last: Frame?
        while let request = readLine() {
            let frame: Frame
            let bytes: Data
            if request == "sample" {
                frame = try await self.frame()
                bytes = try sample(frame.image)
                last = frame
            } else if request == "jpeg", let saved = last {
                frame = saved
                bytes = try Self.jpeg(saved.image)
            } else {
                throw NativeFailure("invalid_arguments")
            }
            guard try verify().bounds == frame.target.bounds else { throw NativeFailure("resized") }
            try sendJSON(["kind": request, "bytes": bytes.count, "target": frame.target.json,
                          "width": frame.image.width, "height": frame.image.height, "dpi": 96])
            write(bytes)
        }
    }
}
