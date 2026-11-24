
import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 150, y: 170, width: 600, height: 360),
                      styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: false)
window.title = "Pane Test Fixture"
let root = NSView(frame: NSRect(x: 0, y: 0, width: 600, height: 360))
let editor = NSTextView(frame: NSRect(x: 25, y: 130, width: 540, height: 180))
editor.string = "margin requirement and sample text"
root.addSubview(editor)
let button = NSButton(title: "Pane test button", target: nil, action: nil)
button.frame = NSRect(x: 32, y: 65, width: 160, height: 30)
root.addSubview(button)
window.contentView = root
window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
window.makeFirstResponder(editor)
editor.setSelectedRange(NSRange(location: 0, length: 18))
withExtendedLifetime(window) { app.run() }
