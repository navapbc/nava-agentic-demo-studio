// demo-capture: records a window or display with ScreenCaptureKit for the
// Nava Agentic Demo Studio.
//
// It writes damage-driven JPEG frames plus frames.json (nava.demo-frames.v1),
// the same format the browser recorder produces, and a pointer log of cursor
// position, button state, and cursor shape. The system cursor is hidden in the
// capture because the renderer draws its own smoothed cursor. Keystrokes are
// never read.
//
//   demo-capture list
//   demo-capture request-access
//   demo-capture record --out DIR [--window ID | --pid PID | --app NAME [--title TEXT] | --display ID]
//                       [--fps 60] [--scale 2] [--quality 0.85] [--url-prefix /recordings/x]
//                       [--seconds N] [--show-cursor] [--activate]
//
// While recording, write "start" to stdin to mark t = 0 (earlier frames
// collapse into frame 0) and "stop" to finalize; closing stdin also stops.
// SIGUSR1 and SIGINT/SIGTERM do the same. Output lines on stdout are JSON.

import AppKit
import CoreGraphics
import CoreImage
import Foundation
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
    print(line)
  }
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  emit(["event": "error", "message": message])
  exit(code)
}

func hostMs() -> Double {
  return CACurrentMediaTime() * 1000
}

struct Options {
  var command = "help"
  var out = ""
  var windowID: CGWindowID?
  var pid: pid_t?
  var app: String?
  var title: String?
  var displayID: CGDirectDisplayID?
  var fps = 60
  var scale: Double = 2
  var quality: Double = 0.85
  var urlPrefix = ""
  var seconds: Double?
  var showCursor = false
  var activate = false
}

func parse() -> Options {
  var options = Options()
  var args = Array(CommandLine.arguments.dropFirst())
  if let first = args.first { options.command = first; args.removeFirst() }
  var index = 0
  func value() -> String {
    index += 1
    guard index < args.count else { fail("Missing value for \(args[index - 1]).") }
    return args[index]
  }
  while index < args.count {
    switch args[index] {
    case "--out": options.out = value()
    case "--window": options.windowID = CGWindowID(value())
    case "--pid": options.pid = pid_t(value())
    case "--app": options.app = value()
    case "--title": options.title = value()
    case "--display": options.displayID = CGDirectDisplayID(value())
    case "--fps": options.fps = Int(value()) ?? 60
    case "--scale": options.scale = Double(value()) ?? 2
    case "--quality": options.quality = Double(value()) ?? 0.85
    case "--url-prefix": options.urlPrefix = value()
    case "--seconds": options.seconds = Double(value())
    case "--show-cursor": options.showCursor = true
    case "--activate": options.activate = true
    default: fail("Unknown option \(args[index]).")
    }
    index += 1
  }
  return options
}

func shareableContent() async -> SCShareableContent {
  do {
    return try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  } catch {
    fail("Screen Recording permission is required. Grant it to the app running this command (System Settings > Privacy & Security > Screen & System Audio Recording), then quit and reopen that app. Details: \(error.localizedDescription)", code: 3)
  }
}

func describe(_ window: SCWindow) -> [String: Any] {
  return [
    "id": window.windowID,
    "app": window.owningApplication?.applicationName ?? "",
    "bundle": window.owningApplication?.bundleIdentifier ?? "",
    "pid": window.owningApplication?.processID ?? 0,
    "title": window.title ?? "",
    "frame": ["x": window.frame.origin.x, "y": window.frame.origin.y, "width": window.frame.width, "height": window.frame.height],
    "layer": window.windowLayer,
  ]
}

// Cursor shape from the current system cursor, matched against the standard
// hand and I-beam cursors by hot spot and image size (cheap enough to run
// many times a second, unlike comparing image data).
final class CursorShapes {
  private func fingerprint(_ cursor: NSCursor) -> String {
    "\(cursor.hotSpot.x),\(cursor.hotSpot.y),\(cursor.image.size.width),\(cursor.image.size.height)"
  }
  private lazy var known: [String: String] = [fingerprint(NSCursor.pointingHand): "pointer", fingerprint(NSCursor.iBeam): "text"]

  func current() -> String? {
    guard let cursor = NSCursor.currentSystem else { return nil }
    return known[fingerprint(cursor)]
  }
}

// Threading: ScreenCaptureKit delivers frames on `frameQueue`, which only does
// bookkeeping; JPEG encoding runs on `writeQueue`; the pointer is sampled on the
// main thread, where AppKit expects to be called. Nothing on the frame path can
// block on AppKit, so frames are never starved and stop always completes.
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let options: Options
  let frameRect: CGRect
  let framesDir: URL
  let context = CIContext(options: [.cacheIntermediates: false])
  let writeQueue = DispatchQueue(label: "demo-capture.write")
  let frameQueue = DispatchQueue(label: "demo-capture.frames")
  private let lock = NSLock()
  private var startMs: Double?
  private var finishing = false
  var stream: SCStream?
  var frames: [[String: Any]] = []
  var pending = 0
  var dropped = 0
  var latestBeforeStart: CIImage?
  var pixelSize = CGSize.zero
  var pointerHandle: FileHandle?
  var pointerTimer: DispatchSourceTimer?
  var lastPointer: (Double, Double, Bool, String?)?

  var t0: Double? {
    lock.lock(); defer { lock.unlock() }
    return startMs
  }

  init(options: Options, frameRect: CGRect) {
    self.options = options
    self.frameRect = frameRect
    self.framesDir = URL(fileURLWithPath: options.out).appendingPathComponent("frames")
  }

  func start(filter: SCContentFilter) async throws {
    try FileManager.default.createDirectory(at: framesDir, withIntermediateDirectories: true)
    let pointerURL = URL(fileURLWithPath: options.out).appendingPathComponent("pointer.jsonl")
    FileManager.default.createFile(atPath: pointerURL.path, contents: nil)
    pointerHandle = try FileHandle(forWritingTo: pointerURL)

    let configuration = SCStreamConfiguration()
    pixelSize = CGSize(width: (frameRect.width * options.scale).rounded(), height: (frameRect.height * options.scale).rounded())
    configuration.width = Int(pixelSize.width)
    configuration.height = Int(pixelSize.height)
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
    configuration.showsCursor = options.showCursor
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    configuration.queueDepth = 8
    configuration.scalesToFit = true
    if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
    let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: frameQueue)
    try await stream.startCapture()
    self.stream = stream
  }

  // Pointer position in the captured frame, normalized 0..1. NSEvent uses a
  // bottom-left origin; ScreenCaptureKit frames use a top-left origin. Runs on
  // the main thread.
  func startPointerLog(shapes: CursorShapes) {
    let mainHeight = NSScreen.screens.first?.frame.height ?? 0
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now(), repeating: .milliseconds(8))
    var tick = 0
    var shape: String?
    timer.setEventHandler { [weak self] in
      guard let self, let t0 = self.t0 else { return }
      tick += 1
      if tick % 6 == 1 { shape = shapes.current() }
      let location = NSEvent.mouseLocation
      let x = Double((location.x - self.frameRect.minX) / self.frameRect.width)
      let y = Double(((mainHeight - location.y) - self.frameRect.minY) / self.frameRect.height)
      let down = (NSEvent.pressedMouseButtons & 1) == 1
      if let last = self.lastPointer, abs(last.0 - x) < 0.0005, abs(last.1 - y) < 0.0005, last.2 == down, last.3 == shape { return }
      self.lastPointer = (x, y, down, shape)
      var entry: [String: Any] = ["t": (hostMs() - t0).rounded(), "x": (x * 10000).rounded() / 10000, "y": (y * 10000).rounded() / 10000, "down": down]
      if let shape { entry["cursor"] = shape }
      if let data = try? JSONSerialization.data(withJSONObject: entry) {
        self.pointerHandle?.write(data)
        self.pointerHandle?.write("\n".data(using: .utf8)!)
      }
    }
    timer.resume()
    pointerTimer = timer
  }

  func markStart() {
    frameQueue.async {
      self.lock.lock(); self.startMs = hostMs(); self.lock.unlock()
      if let image = self.latestBeforeStart { self.save(image, t: 0) }
      emit(["event": "started"])
    }
  }

  var statusCounts: [String: Int] = [:]

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid else { return }
    let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
    let statusValue = attachments?.first?[.status] as? Int
    let status = statusValue.flatMap { SCFrameStatus(rawValue: $0) }
    statusCounts[status.map { String(describing: $0.rawValue) } ?? "unknown", default: 0] += 1
    guard status == .complete, let pixelBuffer = sampleBuffer.imageBuffer else { return }
    let presented = CMTimeGetSeconds(sampleBuffer.presentationTimeStamp) * 1000
    let image = CIImage(cvPixelBuffer: pixelBuffer)
    guard let t0 else {
      latestBeforeStart = image
      return
    }
    save(image, t: max(0, presented - t0))
  }

  // Encodes on a background queue; if encoding falls behind, newer frames are
  // dropped so the recording never lags behind real time. Runs on frameQueue.
  func save(_ image: CIImage, t: Double) {
    if pending > 6 { dropped += 1; return }
    pending += 1
    let index = frames.count + 1
    let name = String(format: "%06d.jpg", index)
    frames.append(["t": t.rounded(), "src": "\(options.urlPrefix)/frames/\(name)"])
    let url = framesDir.appendingPathComponent(name)
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let quality = options.quality
    writeQueue.async {
      let opaque = image.composited(over: CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: image.extent))
      let data = self.context.jpegRepresentation(of: opaque, colorSpace: colorSpace, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality])
      try? data?.write(to: url)
      self.frameQueue.async { self.pending -= 1 }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emit(["event": "error", "message": "Capture stopped: \(error.localizedDescription)"])
    DispatchQueue.global().async { self.finish() }
  }

  // Called off the main thread. Stops the stream, drains both queues, writes
  // frames.json, and exits.
  func debug(_ message: String) {
    if ProcessInfo.processInfo.environment["DEMO_CAPTURE_DEBUG"] != nil { FileHandle.standardError.write("debug: \(message)\n".data(using: .utf8)!) }
  }

  func finish() {
    debug("finish: begin")
    lock.lock()
    if finishing { lock.unlock(); return }
    finishing = true
    lock.unlock()
    pointerTimer?.cancel()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      try? await self.stream?.stopCapture()
      done.signal()
    }
    _ = done.wait(timeout: .now() + 5)
    debug("finish: stream stopped")
    frameQueue.sync {}
    debug("finish: frames drained")
    writeQueue.sync {}
    debug("finish: writes drained")
    let (frames, dropped, pixelSize) = frameQueue.sync { (self.frames, self.dropped, self.pixelSize) }
    DispatchQueue.main.sync { try? self.pointerHandle?.close() }
    debug("finish: pointer log closed")
    let durationMs = t0.map { hostMs() - $0 } ?? 0
    let manifest: [String: Any] = [
      "schema": "nava.demo-frames.v1",
      "origin": "screen",
      "width": Int(pixelSize.width),
      "height": Int(pixelSize.height),
      "viewport": ["width": frameRect.width.rounded(), "height": frameRect.height.rounded()],
      "deviceScaleFactor": options.scale,
      "durationMs": durationMs.rounded(),
      "frames": frames,
    ]
    if let data = try? JSONSerialization.data(withJSONObject: manifest) {
      try? data.write(to: URL(fileURLWithPath: options.out).appendingPathComponent("frames.json"))
    }
    let statuses = frameQueue.sync { self.statusCounts }
    emit(["event": "stopped", "frames": frames.count, "dropped": dropped, "durationMs": durationMs.rounded(), "statuses": statuses])
    exit(0)
  }
}

let options = parse()

switch options.command {
case "request-access":
  emit(["event": "access", "granted": CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()])
  exit(0)

case "list":
  let semaphore = DispatchSemaphore(value: 0)
  Task {
    let content = await shareableContent()
    emit([
      "event": "targets",
      "displays": content.displays.map { ["id": $0.displayID, "width": $0.width, "height": $0.height, "frame": ["x": $0.frame.origin.x, "y": $0.frame.origin.y]] },
      "windows": content.windows.filter { $0.windowLayer == 0 && $0.frame.width > 80 && $0.frame.height > 80 }.map(describe),
    ])
    semaphore.signal()
  }
  semaphore.wait()
  exit(0)

case "record":
  guard !options.out.isEmpty else { fail("record needs --out DIR.") }
  // Connect to the window server before touching AppKit on any thread.
  NSApplication.shared.setActivationPolicy(.prohibited)
  // macOS draws no app windows while the screen is locked, so a capture would
  // only ever receive idle frames.
  if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.loginwindow" {
    fail("The screen is locked. Screen recording needs an unlocked, awake display; use \"recorder\": \"window\" to record a browser unattended.", code: 6)
  }
  let shapes = CursorShapes()
  var recorder: Recorder?
  let started = DispatchSemaphore(value: 0)
  Task {
    let content = await shareableContent()
    let windows = content.windows.filter { $0.windowLayer == 0 && $0.frame.width > 80 && $0.frame.height > 80 }
    let window: SCWindow? = {
      if let id = options.windowID { return windows.first { $0.windowID == id } }
      if let pid = options.pid { return windows.filter { $0.owningApplication?.processID == pid }.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height } }
      if let app = options.app {
        return windows.filter { ($0.owningApplication?.applicationName ?? "") == app && (options.title == nil || ($0.title ?? "").contains(options.title!)) }
          .max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
      }
      return nil
    }()
    let filter: SCContentFilter
    let rect: CGRect
    if let window {
      // Apps such as Chrome stop painting windows that are covered or on
      // another Space, so a recorded window can be brought to the front.
      if options.activate, let pid = window.owningApplication?.processID {
        DispatchQueue.main.async { NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows]) }
      }
      filter = SCContentFilter(desktopIndependentWindow: window)
      rect = window.frame
      emit(["event": "target", "window": describe(window)])
    } else if options.windowID != nil || options.pid != nil || options.app != nil {
      fail("No matching on-screen window. Run `demo-capture list` to see windows.", code: 4)
    } else {
      guard let display = content.displays.first(where: { options.displayID == nil || $0.displayID == options.displayID }) else { fail("No matching display.", code: 4) }
      filter = SCContentFilter(display: display, excludingWindows: [])
      rect = display.frame
      emit(["event": "target", "display": display.displayID])
    }
    let instance = Recorder(options: options, frameRect: rect)
    do {
      try await instance.start(filter: filter)
    } catch {
      fail("Could not start capture: \(error.localizedDescription)", code: 5)
    }
    recorder = instance
    emit(["event": "ready", "width": Int(instance.pixelSize.width), "height": Int(instance.pixelSize.height)])
    started.signal()
  }
  started.wait()
  recorder?.startPointerLog(shapes: shapes)
  let startSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
  signal(SIGUSR1, SIG_IGN)
  startSource.setEventHandler { recorder?.markStart() }
  startSource.resume()
  var stops: [DispatchSourceSignal] = []
  for signalNumber in [SIGINT, SIGTERM] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler { DispatchQueue.global().async { recorder?.finish() } }
    source.resume()
    stops.append(source)
  }
  // Control channel: "start" marks t = 0, "stop" (or the parent closing stdin)
  // finishes. Signals remain as a fallback for manual use.
  Thread.detachNewThread {
    while let line = readLine() {
      switch line.trimmingCharacters(in: .whitespaces) {
      case "start": DispatchQueue.main.async { recorder?.markStart() }
      case "stop": DispatchQueue.global().async { recorder?.finish() }
      default: break
      }
    }
    DispatchQueue.global().async { recorder?.finish() }
  }
  if let seconds = options.seconds {
    recorder?.markStart()
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { DispatchQueue.global().async { recorder?.finish() } }
  }
  RunLoop.main.run()

default:
  print("""
  demo-capture list
  demo-capture request-access
  demo-capture record --out DIR [--window ID | --pid PID | --app NAME [--title TEXT] | --display ID]
                      [--fps 60] [--scale 2] [--quality 0.85] [--url-prefix /recordings/x] [--seconds N] [--show-cursor] [--activate]
  """)
}
