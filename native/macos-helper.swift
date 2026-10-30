// macOS Computer Use helper for @local/dsh-computer-use.
//
// Protocol: `macos-helper <command> <jsonArgs>`; one JSON object on stdout.
// Commands: screenshot | listWindows | axstate | click | type | keypress |
//           scroll | openapp | activate | permissions
//
// Build:  xcrun swiftc -O native/macos-helper.swift -o native/macos-helper
//
// System permissions required (grant the helper binary in System Settings):
//   - Accessibility   (CGEvent posting, AXUIElement) -> Privacy & Security > Accessibility
//   - Screen Recording (ScreenCaptureKit capture)    -> Privacy & Security > Screen Recording

import Foundation
import CoreGraphics
import ApplicationServices
import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision

// MARK: - JSON plumbing

func fail(_ message: String, code: String = "HELPER_ERROR") -> [String: Any] {
    ["ok": false, "error": message, "code": code]
}

func ok(_ extra: [String: Any] = [:]) -> [String: Any] {
    var out: [String: Any] = ["ok": true]
    for (k, v) in extra { out[k] = v }
    return out
}

func toJson(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value) else { return "{}" }
    let data = try! JSONSerialization.data(withJSONObject: value, options: [])
    return String(data: data, encoding: .utf8) ?? "{}"
}

func parseArgs(_ json: String) -> [String: Any] {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return fail("invalid arguments JSON")
    }
    return obj
}

func double(_ args: [String: Any], _ key: String) -> Double? {
    (args[key] as? NSNumber)?.doubleValue
}

// MARK: - Permissions

func checkPermissions() -> [String: Bool] {
    let ax = AXIsProcessTrusted()
    let sr = CGPreflightScreenCaptureAccess()
    return ["accessibility": ax, "screenRecording": sr]
}

func requestPermissions() -> [String: Any] {
    // Triggers the system prompts: Accessibility (AX API) and Screen Recording.
    // Each prompt offers "Open System Settings", which lands on the matching pane.
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    _ = CGRequestScreenCaptureAccess()
    usleep(300_000)
    return ok(checkPermissions())
}

// MARK: - Screenshot (ScreenCaptureKit)

final class ScreenCapturer: NSObject, SCStreamOutput {
    let sem = DispatchSemaphore(value: 0)
    private(set) var image: CGImage?
    private(set) var errorMessage: String?

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, errorMessage == nil else { return }
        guard let frame = sampleBuffer.imageBuffer else { return }
        let ci = CIImage(cvImageBuffer: frame)
        image = CIContext().createCGImage(ci, from: ci.extent)
        sem.signal()
    }
}

func captureContent(windowId: CGWindowID? = nil) -> (CGImage?, Double, [String: Any]?) {
    guard windowId != nil else { return (nil, 0, fail("需要目标窗口", code: "TARGET_REQUIRED")) }
    let perms = checkPermissions()
    guard perms["screenRecording"] == true else {
        return (nil, 0, fail("屏幕录制权限未授予：请在 系统设置 → 隐私与安全性 → 屏幕录制 中添加本 helper",
             code: "SCREEN_RECORDING_REQUIRED"))
    }
    var content: SCShareableContent?
    var contentError: Error?
    let ready = DispatchSemaphore(value: 0)
    Task {
        do { content = try await SCShareableContent.current }
        catch { contentError = error }
        ready.signal()
    }
    ready.wait()
    guard let content = content, let display = content.displays.first else {
        return (nil, 0, fail("无法获取屏幕内容: \(String(describing: contentError))", code: "CAPTURE_FAILED"))
    }
    // Window-scoped capture: ScreenCaptureKit reads the window's own content
    // even when it is occluded by other windows (the Codex-style background
    // observation). A missing window is an error.
    let filter: SCContentFilter
    var capWidth = display.width
    var capHeight = display.height
    if let windowId = windowId {
        guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
            return (nil, 0, fail("目标窗口不存在", code: "WINDOW_NOT_FOUND"))
        }
        filter = SCContentFilter(desktopIndependentWindow: window)
        capWidth = Int(window.frame.width * (NSScreen.main?.backingScaleFactor ?? 2))
        capHeight = Int(window.frame.height * (NSScreen.main?.backingScaleFactor ?? 2))
    } else {
        filter = SCContentFilter(display: display, excludingWindows: [])
    }
    let config = SCStreamConfiguration()
    config.width = capWidth
    config.height = capHeight
    config.showsCursor = false
    var capturedImage: CGImage?
    var failure: Error?
    let captured = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
            capturedImage = image
            failure = error
            captured.signal()
        }
    } else {
        return (nil, 0, fail("窗口截图需要 macOS 14 或更新版本", code: "OS_UNSUPPORTED"))
    }
    guard captured.wait(timeout: .now() + .seconds(10)) == .success,
          let image = capturedImage else {
        return (nil, 0, fail("窗口截图失败: \(String(describing: failure))", code: "CAPTURE_FAILED"))
    }
    let scale = NSScreen.main?.backingScaleFactor ?? 2.0
    return (image, scale, nil)
}

func screenshot(_ args: [String: Any]) -> [String: Any] {
    guard let pid = (args["pid"] as? NSNumber)?.int32Value else {
        return fail("截图需要目标应用 pid", code: "TARGET_REQUIRED")
    }
    let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
    let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
    let candidates = rows.filter {
        guard let frame = $0[kCGWindowBounds as String] as? [String: Any] else { return false }
        return ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
            ($0[kCGWindowLayer as String] as? Int) == 0 &&
            (frame["Width"] as? Double ?? 0) > 100 && (frame["Height"] as? Double ?? 0) > 100
    }.sorted {
        let a = $0[kCGWindowBounds as String] as? [String: Double] ?? [:]
        let b = $1[kCGWindowBounds as String] as? [String: Double] ?? [:]
        return (a["Width"] ?? 0) * (a["Height"] ?? 0) > (b["Width"] ?? 0) * (b["Height"] ?? 0)
    }
    guard let row = candidates.first, let number = row[kCGWindowNumber as String] as? NSNumber,
    let bounds = row[kCGWindowBounds as String] as? [String: Any] else {
        return fail("目标应用没有可截图窗口", code: "WINDOW_NOT_FOUND")
    }
    let (image, scale, captureError) = captureContent(windowId: number.uint32Value)
    guard let image = image else { return captureError! }
    let dir = NSTemporaryDirectory()
    let privateDir = dir + "dsh-computer-use-\(UUID().uuidString)/"
    do { try FileManager.default.createDirectory(atPath: privateDir, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
    catch { return fail("无法创建截图目录", code: "CAPTURE_FAILED") }
    let path = privateDir + "capture.png"
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                     UTType.png.identifier as CFString, 1, nil) else {
        return fail("无法创建 PNG 目标", code: "CAPTURE_FAILED")
    }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else {
        return fail("PNG 写入失败", code: "CAPTURE_FAILED")
    }
    return ok(["path": path,
        "width": image.width,
        "height": image.height,
        "scaleFactor": scale,
        "mimeType": "image/png",
        "scope": "window",
        "origin": ["x": bounds["X"] ?? 0, "y": bounds["Y"] ?? 0],
        "screenBounds": bounds])
}

func ocr(_ args: [String: Any]) -> [String: Any] {
    // Vision OCR over the screen (or one window when `windowId` is given):
    // returns recognized text with pixel boxes (top-left origin, physical
    // pixels) — a visual fallback for apps that expose no Accessibility
    // tree (e.g. Electron), including occluded windows.
    let windowId = (args["windowId"] as? NSNumber)?.uint32Value
    let (image, scale, captureError) = captureContent(windowId: windowId)
    guard let image = image else { return captureError! }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    let handler = VNImageRequestHandler(cgImage: image)
    do {
        try handler.perform([request])
    } catch {
        return fail("OCR 失败: \(error)", code: "OCR_FAILED")
    }
    let w = CGFloat(image.width)
    let h = CGFloat(image.height)
    let items: [[String: Any]] = (request.results ?? []).compactMap { observation in
        guard let top = observation.topCandidates(1).first else { return nil }
        let bb = observation.boundingBox // normalized, bottom-left origin
        let box: [String: Any] = [
            "x": bb.minX * w,
            "y": (1 - bb.maxY) * h,
            "width": bb.width * w,
            "height": bb.height * h,
        ]
        return ["text": top.string, "box": box]
    }
    return ok(["items": items, "scaleFactor": scale, "width": image.width, "height": image.height])
}

// MARK: - Window list

func windowBounds(_ dict: [String: Any]) -> [String: Any] {
    if let b = dict[kCGWindowBounds as String] as? [String: Any] {
        return ["x": b["X"] ?? 0, "y": b["Y"] ?? 0,
                "width": b["Width"] ?? 0, "height": b["Height"] ?? 0]
    }
    return ["x": 0, "y": 0, "width": 0, "height": 0]
}

func listWindows() -> [String: Any] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return fail("无法枚举窗口", code: "WINDOW_LIST_FAILED")
    }
    let windows = list.map { w -> [String: Any] in
        ["pid": w[kCGWindowOwnerPID as String] ?? 0,
         "ownerName": w[kCGWindowOwnerName as String] ?? "",
         "windowId": w[kCGWindowNumber as String] ?? 0,
         "title": w[kCGWindowName as String] ?? "",
         "bounds": windowBounds(w),
         "isOnScreen": w[kCGWindowIsOnscreen as String] ?? false]
    }
    return ok(["windows": windows])
}

// MARK: - Events (require Accessibility permission)

func requireAX() -> [String: Any]? {
    guard AXIsProcessTrusted() else {
        return fail("辅助功能权限未授予：请在 系统设置 → 隐私与安全性 → 辅助功能 中添加本 helper",
             code: "ACCESSIBILITY_REQUIRED")
    }
    return nil
}

func post(_ event: CGEvent, to pid: pid_t? = nil) {
    if let pid = pid {
        // Background (virtual) input: deliver the event directly to the target
        // process without going through the HID layer, so the user's real
        // mouse pointer never moves.
        event.postToPid(pid)
    } else {
        event.post(tap: .cghidEventTap)
    }
    usleep(30_000)
}

func moveMouse(_ x: Double, _ y: Double, to pid: pid_t? = nil) {
    let point = CGPoint(x: x, y: y)
    if let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left) {
        post(move, to: pid)
    }
}

func targetPid(_ args: [String: Any]) -> pid_t? {
    // Background mode: events go to this pid without moving the real pointer.
    (args["pid"] as? NSNumber)?.int32Value
}

func click(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    let x: Double
    if let v = double(args, "x") { x = v } else { return fail("click 需要 x") }
    let y: Double
    if let v = double(args, "y") { y = v } else { return fail("click 需要 y") }
    let buttonName = (args["button"] as? String) ?? "left"
    let button: CGMouseButton = buttonName == "right" ? .right : (buttonName == "middle" ? .center : .left)
    let pid = targetPid(args)
    let point = CGPoint(x: x, y: y)
    if pid == nil {
        moveMouse(x, y)
        usleep(60_000)
    }
    if let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: button) {
        post(down, to: pid)
    }
    if let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: button) {
        post(up, to: pid)
    }
    return ok()
}

func typeText(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    guard let text = args["text"] as? String else { return fail("type 需要 text") }
    let pid = targetPid(args)
    for scalar in text.unicodeScalars {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { continue }
        var code = UInt16(scalar.value)
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &code)
        post(down, to: pid)
        guard let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { continue }
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &code)
        post(up, to: pid)
        usleep(20_000)
    }
    return ok()
}

// MARK: - Keycodes

let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "backspace": 51, "delete": 51,
    "escape": 53, "command": 55, "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59, "fn": 63, "f17": 64, "period": 47, "f18": 65,
    "f19": 66, "f20": 67, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100,
    "f9": 101, "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109,
    "f12": 111, "f15": 113, "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117,
    "f4": 118, "end": 119, "f2": 120, "pagedown": 121, "f1": 122, "left": 123,
    "right": 124, "down": 125, "up": 126,
]

func keyFlags(_ modifier: String) -> CGEventFlags {
    switch modifier {
    case "command", "cmd", "meta", "super": return .maskCommand
    case "shift": return .maskShift
    case "option", "alt": return .maskAlternate
    case "control", "ctrl": return .maskControl
    case "fn": return .maskSecondaryFn
    default: return []
    }
}

func pressKey(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    guard let chord = args["key"] as? String, !chord.isEmpty else { return fail("keypress 需要 key") }
    let parts = chord.split(separator: "+").map(String.init)
    var flags: CGEventFlags = []
    var keyName = ""
    for p in parts {
        let lower = p.lowercased()
        if ["command", "cmd", "meta", "super", "shift", "option", "alt", "control", "ctrl", "fn"].contains(lower) {
            flags.insert(keyFlags(lower))
        } else {
            keyName = lower
        }
    }
    let code: CGKeyCode
    if let v = KEYCODES[keyName] { code = v } else { return fail("不支持的按键: \(chord)") }
    let pid = targetPid(args)
    if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
        down.flags = flags
        post(down, to: pid)
    }
    usleep(40_000)
    if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
        up.flags = flags
        post(up, to: pid)
    }
    return ok()
}

func scroll(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    let x = double(args, "x") ?? 0
    let y = double(args, "y") ?? 0
    let dx = double(args, "deltaX") ?? 0
    let dy = double(args, "deltaY") ?? 0
    let pid = targetPid(args)
    if pid == nil { moveMouse(x, y) }
    if let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                           wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) {
        post(event, to: pid)
    }
    return ok()
}

func mousePosition() -> [String: Any] {
    // Current real pointer location, for verifying background input never
    // moves the user's mouse.
    if let event = CGEvent(source: nil) {
        let p = event.location
        return ok(["x": p.x, "y": p.y])
    }
    return fail("无法读取鼠标位置", code: "MOUSE_POSITION_FAILED")
}

// MARK: - AX state

let INTERACTIVE_ROLES: Set<String> = [
    kAXButtonRole as String, kAXTextFieldRole as String, kAXCheckBoxRole as String,
    kAXRadioButtonRole as String, kAXMenuItemRole as String, kAXPopUpButtonRole as String,
    kAXComboBoxRole as String, kAXTabGroupRole as String, "AXLink",
    kAXCellRole as String, kAXSliderRole as String, kAXDisclosureTriangleRole as String,
    kAXTextAreaRole as String, "AXSearchField", kAXStaticTextRole as String,
]

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute, &value)
    guard err == .success, let value = value else { return nil }
    if CFGetTypeID(value) == CFStringGetTypeID() { return value as? String }
    return nil
}

func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
    return point
}

func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
          let value = value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
    return size
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let value = value, CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
    return (value as? [AXUIElement]) ?? []
}

struct AXWalker {
    var collected: [[String: Any]] = []
    var refs: [AXUIElement] = []
    var budget: Int
    var depthLeft: Int

    mutating func walk(_ element: AXUIElement) {
        guard depthLeft > 0, budget > 0 else { return }
        depthLeft -= 1
        let role = axString(element, kAXRoleAttribute as CFString) ?? ""
        if INTERACTIVE_ROLES.contains(role) {
            let title = axString(element, kAXTitleAttribute as CFString) ?? ""
            let value = axString(element, kAXValueAttribute as CFString) ?? ""
            let desc = axString(element, kAXDescriptionAttribute as CFString) ?? ""
            let label = title.isEmpty ? (desc.isEmpty ? value : desc) : title
            var box: [String: Any] = [:]
            if let p = axPoint(element, kAXPositionAttribute as CFString),
               let s = axSize(element, kAXSizeAttribute as CFString) {
                box = ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
            }
            collected.append(["role": role, "label": label, "box": box, "index": refs.count])
            refs.append(element)
            budget -= 1
        }
        for child in axChildren(element) {
            walk(child)
        }
        depthLeft += 1
    }
}

func axTree(pid: pid_t) -> (app: [String: Any], window: [String: Any]?, elements: [[String: Any]], refs: [AXUIElement]) {
    let app = NSRunningApplication(processIdentifier: pid)
    let appElement = AXUIElementCreateApplication(pid)
    var windowRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowRef)
    guard err == .success, let windowList = windowRef as? [AXUIElement], !windowList.isEmpty else {
        return (["name": app?.localizedName ?? "", "pid": pid], nil, [], [])
    }
    let mainWindow = windowList[0]
    var walker = AXWalker(budget: 200, depthLeft: 8)
    walker.walk(mainWindow)
    var wBox: [String: Any] = [:]
    if let p = axPoint(mainWindow, kAXPositionAttribute as CFString),
       let s = axSize(mainWindow, kAXSizeAttribute as CFString) {
        wBox = ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
    }
    let window: [String: Any] = [
        "title": axString(mainWindow, kAXTitleAttribute as CFString) ?? "",
        "box": wBox,
    ]
    return (["name": app?.localizedName ?? "", "pid": pid], window, walker.collected, walker.refs)
}

func axState(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    let pid = targetPid(args) ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard let pid = pid else { return fail("无法解析目标应用", code: "AX_FAILED") }
    let (app, window, elements, _) = axTree(pid: pid)
    return ok(["app": app, "window": window, "elements": elements])
}

func axPress(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    let pid = targetPid(args)
    guard let pid = pid else { return fail("axpress 需要 pid") }
    let (_, _, _, refs) = axTree(pid: pid)

    func strip(_ s: String) -> String {
        s.replacingOccurrences(of: "\u{200e}", with: "")
          .replacingOccurrences(of: "\u{200f}", with: "")
          .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Prefer label matching (order-independent; AX trees can reorder as the
    // UI state changes). Falls back to an explicit index.
    if let label = args["label"] as? String {
        let want = strip(label)
        for (i, ref) in refs.enumerated() {
            let l = strip((axString(ref, kAXTitleAttribute as CFString) ?? "")
                + (axString(ref, kAXValueAttribute as CFString) ?? "")
                + (axString(ref, kAXDescriptionAttribute as CFString) ?? ""))
            if l == want {
                let error = AXUIElementPerformAction(ref, kAXPressAction as CFString)
                if error != .success { return fail("AX press 失败: \(error.rawValue)", code: "AX_PRESS_FAILED") }
                return ok(["index": i, "label": label])
            }
        }
        return fail("未找到元素: \(label)", code: "AX_LABEL_NOT_FOUND")
    }

    let index = (args["index"] as? NSNumber)?.intValue
    guard let index = index else { return fail("axpress 需要 index 或 label") }
    guard index >= 0, index < refs.count else { return fail("元素索引越界: \(index)", code: "AX_INDEX_OUT_OF_RANGE") }
    let element = refs[index]
    let error = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if error != .success {
        return fail("AX press 失败: \(error.rawValue)", code: "AX_PRESS_FAILED")
    }
    return ok(["index": index])
}

func axSetValue(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    let pid = targetPid(args)
    let label = args["label"] as? String
    let value = args["value"] as? String
    guard let pid = pid, let label = label, let value = value else { return fail("axsetvalue 需要 pid/label/value") }
    let (_, _, _, refs) = axTree(pid: pid)
    for ref in refs {
        let l = (axString(ref, kAXTitleAttribute as CFString) ?? "")
            + (axString(ref, kAXValueAttribute as CFString) ?? "")
            + (axString(ref, kAXDescriptionAttribute as CFString) ?? "")
        if l == label {
            let error = AXUIElementSetAttributeValue(ref, kAXValueAttribute as CFString, value as CFTypeRef)
            if error != .success { return fail("AX setValue 失败: \(error.rawValue)", code: "AX_SETVALUE_FAILED") }
            return ok(["label": label])
        }
    }
    return fail("未找到文本框: \(label)", code: "AX_LABEL_NOT_FOUND")
}

func axRaise(_ args: [String: Any]) -> [String: Any] {
    if let axErr = requireAX() { return axErr }
    let pid = targetPid(args)
    guard let pid = pid else { return fail("axraise 需要 pid") }
    let appElement = AXUIElementCreateApplication(pid)
    var windowRef: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowRef)
    guard err == .success, let windowList = windowRef as? [AXUIElement], !windowList.isEmpty else {
        return fail("目标应用没有窗口", code: "AX_NO_WINDOW")
    }
    // Raise the first window to the front WITHOUT activating the app:
    // the window becomes visible for screenshots/GIFs while focus stays with
    // the user's current application.
    let window = windowList[0]
    let actionError = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    if actionError != .success {
        return fail("AX raise 失败: \(actionError.rawValue)", code: "AX_RAISE_FAILED")
    }
    return ok()
}

// MARK: - App launch

func appMatches(_ app: NSRunningApplication, _ query: String) -> Bool {
    let q = query.lowercased()
    let name = (app.localizedName ?? "").lowercased()
    let file = (app.bundleURL?.lastPathComponent ?? "").lowercased()
    let bid = (app.bundleIdentifier ?? "").lowercased()
    return name.contains(q) || file.hasPrefix(q) || file == q + ".app" || bid == q
}

func openApp(_ args: [String: Any]) -> [String: Any] {
    guard let query = args["query"] as? String, !query.isEmpty else { return fail("openapp 需要 query") }
    let ws = NSWorkspace.shared

    if query.contains(".") {
        if let app = ws.runningApplications.first(where: { appMatches($0, query) }) {
            app.activate(options: [.activateAllWindows])
            return ok(["pid": app.processIdentifier, "name": app.localizedName ?? query, "activated": true])
        }
        if let url = ws.urlForApplication(withBundleIdentifier: query),
           ws.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) != nil {
            usleep(900_000)
            let app = ws.runningApplications.first(where: { appMatches($0, query) })
            return ok(["pid": app?.processIdentifier ?? 0, "name": app?.localizedName ?? query, "activated": false])
        }
        return fail("无法启动应用 bundleId: \(query)", code: "APP_LAUNCH_FAILED")
    }

    if let app = ws.runningApplications.first(where: { appMatches($0, query) }) {
        app.activate(options: [.activateAllWindows])
        return ok(["pid": app.processIdentifier, "name": app.localizedName ?? query, "activated": true])
    }

    // Launch by name via LaunchServices (`open -a`), which activates the app.
    let openProc = Process()
    openProc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    openProc.arguments = ["-a", query]
    try? openProc.run()
    openProc.waitUntilExit()
    usleep(900_000)
    if let app = ws.runningApplications.first(where: { appMatches($0, query) }) {
        app.activate(options: [.activateAllWindows])
        return ok(["pid": app.processIdentifier, "name": app.localizedName ?? query, "activated": true])
    }

    let dirs = ["/Applications", NSString("~/Applications").expandingTildeInPath, "/System/Applications"]
    for dir in dirs {
        if let apps = try? FileManager.default.contentsOfDirectory(atPath: dir) {
            if let hit = apps.first(where: { $0.lowercased().hasPrefix(query.lowercased()) && $0.hasSuffix(".app") }) {
                let url = URL(fileURLWithPath: dir + "/" + hit)
                if ws.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration()) != nil {
                    usleep(900_000)
                    let app = ws.runningApplications.first(where: { ($0.localizedName ?? "").lowercased() == query.lowercased() })
                    return ok(["pid": app?.processIdentifier ?? 0, "name": String(hit.dropLast(4)), "activated": false])
                }
            }
        }
    }
    return fail("未找到应用: \(query)", code: "APP_NOT_FOUND")
}

func activateApp(_ args: [String: Any]) -> [String: Any] {
    guard let pid = (args["pid"] as? NSNumber)?.int32Value else { return fail("activate 需要 pid") }
    if let app = NSRunningApplication(processIdentifier: pid) {
        app.activate(options: [.activateAllWindows])
        return ok()
    }
    return fail("无效 pid: \(pid)", code: "APP_NOT_FOUND")
}

// MARK: - Main

// MARK: - Main

func runMain(_ command: String, _ parsed: [String: Any]) -> [String: Any] {
    switch command {
    case "permissions":
        return ok(checkPermissions())
    case "requestpermissions":
        return requestPermissions()
    case "screenshot":
        return screenshot(parsed)
    case "ocr":
        return ocr(parsed)
    case "listWindows":
        return listWindows()
    case "axstate":
        return axState(parsed)
    case "axpress":
        return axPress(parsed)
    case "axraise":
        return axRaise(parsed)
    case "axsetvalue":
        return axSetValue(parsed)
    case "click":
        return click(parsed)
    case "type":
        return typeText(parsed)
    case "keypress":
        return pressKey(parsed)
    case "scroll":
        return scroll(parsed)
    case "mousepos":
        return mousePosition()
    case "openapp":
        return openApp(parsed)
    case "activate":
        return activateApp(parsed)
    default:
        return fail("未知命令: \(command)")
    }
}

func daemonMain() {
    // Resident helper: one JSON command per stdin line, executed IN THIS
    // PROCESS on a serial queue (no child processes — WindowServer calls are
    // unreliable from daemon-spawned children in some display environments).
    // Results print on stdout; a thrown/crashed command only kills one call
    // thanks to the serial executor, and the daemon keeps reading.
    let queue = DispatchQueue(label: "dsh-helper")
    while let line = readLine() {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cmd = obj["cmd"] as? String else { continue }
        let cmdArgs = (obj["args"] as? [String: Any]) ?? [:]
        queue.sync {
            let result = runMain(cmd, cmdArgs)
            print(toJson(result))
            fflush(stdout)
        }
    }
    exit(0)
}

let args = CommandLine.arguments
guard args.count >= 2 else { print(toJson(fail("用法: macos-helper <command> [jsonArgs]"))); exit(1) }
let command = args[1]
let jsonArgs = args.count >= 3 ? args[2] : "{}"
let parsed = parseArgs(jsonArgs)

if command == "daemon" {
    daemonMain()
} else {
    print(toJson(runMain(command, parsed)))
    exit(0)
}
