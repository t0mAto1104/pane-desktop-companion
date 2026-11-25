
import AppKit
import ApplicationServices

private func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}

private func parameterized(_ element: AXUIElement, _ key: String, _ parameter: CFTypeRef) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyParameterizedAttributeValue(element, key as CFString, parameter, &value) == .success ? value : nil
}

private func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func extract<T>(_ value: CFTypeRef?, _ type: AXValueType, _ output: inout T) -> Bool {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return false }
    let ax = value as! AXValue
    guard AXValueGetType(ax) == type else { return false }
    return withUnsafeMutablePointer(to: &output) { AXValueGetValue(ax, type, $0) }
}

private func process(_ element: AXUIElement, matches pid: pid_t) -> Bool {
    var owner: pid_t = 0
    return AXUIElementGetPid(element, &owner) == .success && owner == pid
}

private func bounds(_ element: AXUIElement) -> CGRect? {
    var position = CGPoint.zero
    var size = CGSize.zero
    guard extract(attribute(element, kAXPositionAttribute), .cgPoint, &position),
          extract(attribute(element, kAXSizeAttribute), .cgSize, &size) else { return nil }
    let rect = CGRect(origin: position, size: size)
    return validRect(rect) ? rect.integral : nil
}

private func protected(_ node: AXUIElement) -> Bool {
    (attribute(node, kAXSubroleAttribute) as? String) == "AXSecureTextField"
        || (attribute(node, kAXRoleAttribute) as? String) == "AXSecureTextField"
        || (attribute(node, "AXProtectedContent") as? Bool) == true
}

@MainActor enum MacAccessibility {
    private static let markerRange = "AXSelectedTextMarkerRange"
    private static let markerString = "AXStringForTextMarkerRange"
    private static let markerBounds = "AXBoundsForTextMarkerRange"

    private static let roles: [String: Int] = [
        "AXButton": 50000, "AXCheckBox": 50002, "AXComboBox": 50003, "AXPopUpButton": 50003,
        "AXTextField": 50004, "AXTextArea": 50004, "AXSearchField": 50004, "AXLink": 50005,
        "AXImage": 50006, "AXList": 50008, "AXMenu": 50010, "AXMenuItem": 50011,
        "AXRadioButton": 50013, "AXScrollBar": 50014, "AXSlider": 50015, "AXTabGroup": 50018,
        "AXTab": 50019, "AXStaticText": 50020, "AXOutline": 50023, "AXRow": 50029,
        "AXGroup": 50026, "AXWebArea": 50030, "AXWindow": 50032, "AXScrollArea": 50033,
        "AXToolbar": 50033, "AXTable": 50036,
    ]

    private static func application(_ target: MacTarget) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw NativeFailure("accessibility_permission") }
        let app = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(app, 0.15)
        return app
    }

    private static func matches(_ node: AXUIElement, _ target: MacTarget) -> Bool {
        guard process(node, matches: target.pid), let rect = bounds(node) else { return false }
        return abs(rect.minX - target.bounds.minX) <= 2 && abs(rect.minY - target.bounds.minY) <= 2
            && abs(rect.width - target.bounds.width) <= 2 && abs(rect.height - target.bounds.height) <= 2
    }

    private static func window(_ app: AXUIElement, _ target: MacTarget) -> AXUIElement? {
        let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).prefix(40)
        let candidates = windows.filter { matches($0, target) }
        if candidates.count == 1 { return candidates[0] }
        let matchingTitles = candidates.filter { (attribute($0, kAXTitleAttribute) as? String) == target.title }
        return matchingTitles.count == 1 ? matchingTitles[0] : nil
    }

    static func inspect(_ target: MacTarget) throws -> [String: Any] {
        let app = try application(target)
        guard let root = window(app, target), !protected(root) else { throw NativeFailure("uia_unavailable") }
        let deadline = ProcessInfo.processInfo.systemUptime + 1.15
        var nodes: [[String: Any]] = []
        var truncated = false
        @discardableResult func visit(_ node: AXUIElement, _ id: String, _ parent: String?, _ depth: Int) -> Bool {
            guard nodes.count < 180, depth <= 10, ProcessInfo.processInfo.systemUptime < deadline else {
                truncated = true
                return false
            }
            guard process(node, matches: target.pid), !protected(node) else { return false }
            let role = attribute(node, kAXRoleAttribute) as? String ?? ""
            let rect = bounds(node)
            let name = (attribute(node, kAXTitleAttribute) as? String)
                ?? (attribute(node, kAXDescriptionAttribute) as? String)
                ?? (role == "AXStaticText" ? attribute(node, kAXValueAttribute) as? String : nil) ?? ""
            let automationId = attribute(node, kAXIdentifierAttribute) as? String ?? ""
            let index = nodes.count
            nodes.append([
                "elementId": id, "name": String(decoding: name.utf16.prefix(160), as: UTF16.self),
                "automationId": String(decoding: automationId.utf16.prefix(160), as: UTF16.self), "controlType": roles[role] ?? 50025,
                "boundingRectangle": rect.map(rectJSON) ?? ["x": 0, "y": 0, "width": 0, "height": 0],
                "isEnabled": attribute(node, kAXEnabledAttribute) as? Bool ?? true,
                "isOffscreen": rect.map { !target.bounds.contains($0) } ?? true,
                "processId": target.pid, "parentId": parent.map { $0 as Any } ?? NSNull(),
            ])
            var count: CFIndex = 0
            var children: CFArray?
            var ids: [String] = []
            if ProcessInfo.processInfo.systemUptime < deadline,
               AXUIElementGetAttributeValueCount(node, kAXChildrenAttribute as CFString, &count) == .success,
               count > 0 {
                let limit = min(count, 180 - nodes.count)
                if count > limit || depth == 10 { truncated = true }
                if limit > 0, depth < 10,
                   AXUIElementCopyAttributeValues(node, kAXChildrenAttribute as CFString, 0, limit, &children) == .success {
                    for (offset, child) in (children as? [AXUIElement] ?? []).enumerated() {
                        let childID = "\(id):\(offset)"
                        if visit(child, childID, id, depth + 1) { ids.append(childID) }
                        if nodes.count >= 180 || ProcessInfo.processInfo.systemUptime >= deadline {
                            truncated = true
                            break
                        }
                    }
                }
            }
            nodes[index]["childrenIds"] = ids
            return true
        }
        visit(root, ":0", nil, 0)
        return ["elements": nodes, "truncated": truncated]
    }

    static func selection(_ target: MacTarget) throws -> [String: Any] {
        let app = try application(target)
        // The timeout on the application element does not apply to the nodes it returns.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.10)
        _ = attribute(app, kAXRoleAttribute)
        let appWindow = element(attribute(app, kAXFocusedWindowAttribute))
        let root = appWindow.flatMap { matches($0, target) ? $0 : nil } ?? window(app, target)
        guard let root, let focused = element(attribute(app, kAXFocusedUIElementAttribute)),
              process(focused, matches: target.pid) else { return ["status": "unsupported"] }
        if protected(root) || protected(focused) { return ["status": "protected"] }
        guard let focusedWindow = element(attribute(focused, kAXWindowAttribute)) ??
                    element(attribute(app, kAXFocusedWindowAttribute)), CFEqual(focusedWindow, root) else {
            return ["status": "changed"]
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.8
        var cursor: AXUIElement? = focused
        var sawEmptyRange = false
        for _ in 0..<10 {
            guard ProcessInfo.processInfo.systemUptime < deadline, let current = cursor,
                  process(current, matches: target.pid), !CFEqual(current, root) else { break }
            if protected(current) { return ["status": "protected"] }
            var range = CFRange(location: 0, length: 0)
            if let rawRange = attribute(current, kAXSelectedTextRangeAttribute), extract(rawRange, .cfRange, &range) {
                guard range.location >= 0, range.length >= 0, range.location <= Int.max - range.length else {
                    return ["status": "changed"]
                }
                if range.length > 6000 { return ["status": "limit"] }
                if range.length > 0, let text = attribute(current, kAXSelectedTextAttribute) as? String,
                   text.utf16.count == range.length {
                    let bounds = parameterized(current, kAXBoundsForRangeParameterizedAttribute, rawRange)
                    var finalRange = CFRange(location: 0, length: 0)
                    guard extract(attribute(current, kAXSelectedTextRangeAttribute), .cfRange, &finalRange),
                          finalRange.location == range.location, finalRange.length == range.length else {
                        return ["status": "changed"]
                    }
                    return selectionResult(text, bounds, target, app, focused, root)
                }
                if range.length == 0 {
                    sawEmptyRange = true
                    let role = attribute(current, kAXRoleAttribute) as? String
                    // An empty form field can coexist with an old selection elsewhere on the page.
                    if role == "AXTextField" || role == "AXTextArea" || role == "AXSearchField" || role == "AXComboBox" {
                        return ["status": "empty"]
                    }
                }
            }
            // Read the live document selection exposed by WebKit and Chromium.
            if let marker = attribute(current, markerRange),
               let text = parameterized(current, markerString, marker) as? String {
                if text.isEmpty {
                    sawEmptyRange = true
                } else {
                    guard text.utf16.count <= 6000, text.unicodeScalars.count <= 3000 else { return ["status": "limit"] }
                    let bounds = parameterized(current, markerBounds, marker)
                    guard let latest = attribute(current, markerRange),
                          (parameterized(current, markerString, latest) as? String) == text else {
                        return ["status": "changed"]
                    }
                    return selectionResult(text, bounds, target, app, focused, root)
                }
            }
            cursor = element(attribute(current, kAXParentAttribute))
        }
        return ["status": sawEmptyRange ? "empty" : "unsupported"]
    }

    private static func selectionResult(_ text: String, _ bounds: CFTypeRef?, _ target: MacTarget,
                                        _ app: AXUIElement, _ focused: AXUIElement, _ root: AXUIElement) -> [String: Any] {
        guard text.utf16.count <= 6000, text.unicodeScalars.count <= 3000 else { return ["status": "limit"] }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return ["status": "empty"] }
        guard let currentFocus = element(attribute(app, kAXFocusedUIElementAttribute)), CFEqual(currentFocus, focused),
              let currentWindow = element(attribute(currentFocus, kAXWindowAttribute)) ??
                element(attribute(app, kAXFocusedWindowAttribute)), CFEqual(currentWindow, root),
              !protected(currentFocus) else { return ["status": "changed"] }
        var rectangle = CGRect.zero
        let rectangles = extract(bounds, .cgRect, &rectangle) && validRect(rectangle)
            && target.bounds.contains(rectangle.integral) ? [rectJSON(rectangle)] : []
        return ["status": "ok", "text": text, "rectangles": rectangles]
    }
}

@MainActor final class MacSelectionWatch {
    private static let chromiumBrowsers: Set<String> = [
        "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.canary", "org.chromium.chromium",
        "com.microsoft.edgemac", "com.brave.browser", "com.vivaldi.vivaldi", "com.operasoftware.opera", "company.thebrowser.browser",
    ]
    private let desktop: MacDesktop
    private let denied: [String]
    private var current: String?
    private var enhancedBrowser: NSRunningApplication?
    private var focused: AXUIElement?
    private var observer: AXObserver?
    private var mouseMonitor: Any?
    private var mouseDown: (point: CGPoint, targetId: String?)?

    init(desktop: MacDesktop, denied: [String]) {
        self.desktop = desktop
        self.denied = denied
    }

    func run() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.08)
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.stop() }
        }
        termination.resume()
        let timer = Timer.scheduledTimer(withTimeInterval: 0.28, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.poll() }
        }
        poll()
        app.run()
        timer.invalidate()
        termination.cancel()
        releaseBrowserAccessibility()
    }

    private func emit(_ event: String) { write(Data((event + "\n").utf8)) }

    private func stop() {
        releaseBrowserAccessibility()
        exit(0)
    }

    private func releaseBrowserAccessibility() {
        if let browser = enhancedBrowser, !browser.isTerminated {
            let app = AXUIElementCreateApplication(browser.processIdentifier)
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
        }
        enhancedBrowser = nil
    }

    private func clearObserver() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
        focused = nil
    }

    private func poll() {
        if kill(desktop.assistant, 0) != 0 { stop() }
        guard MacDesktop.sessionAvailable, AXIsProcessTrusted() else {
            if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
            mouseMonitor = nil
            mouseDown = nil
            clearObserver()
            releaseBrowserAccessibility()
            current = nil
            return
        }
        if mouseMonitor == nil {
            mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] event in
                MainActor.assumeIsolated { self?.mouse(event) }
            }
        }
        let target = try? desktop.foreground(denied)
        updateTarget(target)
        guard let target else { return }
        let app = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(app, 0.08)
        guard let node = element(attribute(app, kAXFocusedUIElementAttribute)), process(node, matches: target.pid),
              !protected(node) else { clearObserver(); return }
        if let focused, CFEqual(focused, node) { return }
        clearObserver()
        focused = node
        var created: AXObserver?
        let status = AXObserverCreate(target.pid, { _, _, _, pointer in
            guard let pointer else { return }
            MainActor.assumeIsolated {
                let watch = Unmanaged<MacSelectionWatch>.fromOpaque(pointer).takeUnretainedValue()
                if MacDesktop.sessionAvailable { watch.emit("selection") }
            }
        }, &created)
        if status == .success, let created,
           AXObserverAddNotification(created, node, kAXSelectedTextChangedNotification as CFString,
                                     Unmanaged.passUnretained(self).toOpaque()) == .success {
            observer = created
            CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(created), .defaultMode)
        }
    }

    private func updateTarget(_ target: MacTarget?) {
        guard target?.id != current else { return }
        current = target?.id
        clearObserver()
        if enhancedBrowser?.processIdentifier != target?.pid { releaseBrowserAccessibility() }
        if let target, enhancedBrowser == nil, Self.chromiumBrowsers.contains(target.executable.lowercased()),
           let browser = NSRunningApplication(processIdentifier: target.pid) {
            // Chromium activates the full document AX tree asynchronously after this request.
            let app = AXUIElementCreateApplication(target.pid)
            _ = attribute(app, kAXRoleAttribute)
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            enhancedBrowser = browser
        }
        emit("focus")
    }

    private func mouse(_ event: NSEvent) {
        guard MacDesktop.sessionAvailable, let point = event.cgEvent?.location ?? CGEvent(source: nil)?.location else { return }
        let target = try? desktop.foreground(denied)
        if event.type == .leftMouseDown {
            mouseDown = (point, target.flatMap { $0.bounds.contains(point) ? $0.id : nil })
            return
        }
        let start = mouseDown
        mouseDown = nil
        updateTarget(target)
        guard let start, hypot(start.point.x - point.x, start.point.y - point.y) > 4 else {
            emit("click")
            return
        }
        if let target, start.targetId == target.id, target.bounds.contains(point) {
            emit("drag \(target.id) \(Int(point.x.rounded())) \(Int(point.y.rounded()))")
        } else {
            emit("drag")
        }
    }
}
