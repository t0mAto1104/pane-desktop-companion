
import AVFoundation
import AudioToolbox
import CoreAudio

enum MacAudio {
    private typealias Device = (id: AudioDeviceID, uid: String, label: String, input: Bool, output: Bool)
    private static let maxRecordingBytes = 16_000 * 2 * 24
    private static let maxPlaybackBytes = 22_050 * 2 * 90

    private static func address(_ selector: AudioObjectPropertySelector,
                                _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func string(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var property = address(selector)
        var value: CFString?
        var length = UInt32(MemoryLayout<CFString?>.size)
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(device, &property, 0, nil, &length, UnsafeMutableRawPointer($0))
        }
        guard status == noErr, let value else { return nil }
        return value as String
    }

    private static func hasStreams(_ device: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Bool {
        var property = address(kAudioDevicePropertyStreams, scope)
        var length: UInt32 = 0
        return AudioObjectGetPropertyDataSize(device, &property, 0, nil, &length) == noErr && length > 0
    }

    private static func devices() -> [Device] {
        let system = AudioObjectID(kAudioObjectSystemObject)
        var property = address(kAudioHardwarePropertyDevices)
        var length: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &property, 0, nil, &length) == noErr,
              length > 0, length <= 4096 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(length) / MemoryLayout<AudioDeviceID>.stride)
        let status = ids.withUnsafeMutableBytes { bytes -> OSStatus in
            guard let pointer = bytes.baseAddress else { return -1 }
            return AudioObjectGetPropertyData(system, &property, 0, nil, &length, pointer)
        }
        guard status == noErr else { return [] }
        return ids.compactMap { device in
            guard let uid = string(device, kAudioDevicePropertyDeviceUID),
                  let label = string(device, kAudioObjectPropertyName) else { return nil }
            return (device, uid, label, hasStreams(device, kAudioDevicePropertyScopeInput),
                    hasStreams(device, kAudioDevicePropertyScopeOutput))
        }
    }

    static func list() -> [[String: String]] {
        devices().flatMap { device in
            [device.input ? ["id": device.uid, "label": device.label, "kind": "input"] : nil,
             device.output ? ["id": device.uid, "label": device.label, "kind": "output"] : nil].compactMap { $0 }
        }
    }

    private static func choose(_ uid: String, input: Bool, node: AVAudioIONode) throws {
        guard !uid.isEmpty else { return }
        guard let selected = devices().first(where: { $0.uid == uid && (input ? $0.input : $0.output) }) else {
            throw NativeFailure("audio_device")
        }
        try node.auAudioUnit.setDeviceID(selected.id)
    }

    private static func converted(_ buffer: AVAudioPCMBuffer, using converter: AVAudioConverter) -> Data? {
        let ratio = converter.outputFormat.sampleRate / buffer.format.sampleRate
        let frames = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio)) + 128
        guard let pcm = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: frames) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: pcm, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true
            state.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, pcm.frameLength > 0, let data = pcm.int16ChannelData?[0] else { return nil }
        return Data(bytes: data, count: Int(pcm.frameLength) * 2)
    }

    private static func pcm(_ sampleRate: Double) -> AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true)!
    }

    private final class Recorder {
        private let lock = NSLock()
        private var sent = 0
        private let converter: AVAudioConverter
        private let finished: DispatchSemaphore

        init(_ converter: AVAudioConverter, _ finished: DispatchSemaphore) {
            self.converter = converter
            self.finished = finished
        }

        func push(_ buffer: AVAudioPCMBuffer) {
            lock.lock()
            defer { lock.unlock() }
            guard sent < maxRecordingBytes, let data = converted(buffer, using: converter) else { return }
            let bytes = data.prefix(maxRecordingBytes - sent)
            write(bytes)
            sent += bytes.count
            if sent >= maxRecordingBytes { finished.signal() }
        }

        func hasAudio() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            return sent > 0
        }
    }

    static func record(_ device: String) throws {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw NativeFailure("microphone_permission")
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        try choose(device, input: true, node: input)
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let converter = AVAudioConverter(from: source, to: pcm(16_000)) else { throw NativeFailure("audio_device") }
        let finished = DispatchSemaphore(value: 0)
        let recorder = Recorder(converter, finished)
        input.installTap(onBus: 0, bufferSize: 1024, format: source) { buffer, _ in recorder.push(buffer) }
        defer { input.removeTap(onBus: 0); engine.stop() }
        try engine.start()
        DispatchQueue.global(qos: .userInitiated).async {
            _ = FileHandle.standardInput.readData(ofLength: 1)
            finished.signal()
        }
        _ = finished.wait(timeout: .now() + 24)
        guard recorder.hasAudio() else { throw NativeFailure("audio_device") }
    }

    private static func readInput(limit: Int) throws -> Data {
        var data = Data()
        while let chunk = try FileHandle.standardInput.read(upToCount: 32_768), !chunk.isEmpty {
            guard data.count + chunk.count <= limit else { throw NativeFailure("audio_too_large") }
            data.append(chunk)
        }
        return data
    }

    static func play(_ device: String, preview: Bool) throws {
        try playPCM(readInput(limit: maxPlaybackBytes), device: device, rate: preview ? 16_000 : 22_050)
    }

    private static func playPCM(_ bytes: Data, device: String, rate: Double) throws {
        guard !bytes.isEmpty, bytes.count % 2 == 0,
              let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(bytes.count / 2)),
              let channel = buffer.floatChannelData?[0] else { throw NativeFailure("audio_device") }
        buffer.frameLength = buffer.frameCapacity
        bytes.withUnsafeBytes { samples in
            for i in 0..<Int(buffer.frameLength) {
                let value = samples.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)
                channel[i] = Float(Int16(littleEndian: value)) / 32_768
            }
        }
        let engine = AVAudioEngine()
        try choose(device, input: false, node: engine.outputNode)
        let player = AVAudioPlayerNode()
        let done = DispatchSemaphore(value: 0)
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        try engine.start()
        defer { player.stop(); engine.stop() }
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in done.signal() }
        player.play()
        guard done.wait(timeout: .now() + min(92, Double(buffer.frameLength) / rate + 3)) == .success else {
            throw NativeFailure("audio_device")
        }
    }

    private final class SpeechBuffer {
        private let lock = NSLock()
        private var data = Data()
        private var done = false
        private var converter: AVAudioConverter?

        func append(_ raw: AVAudioBuffer) {
            lock.lock()
            defer { lock.unlock() }
            guard !done, let buffer = raw as? AVAudioPCMBuffer else { return }
            if buffer.frameLength == 0 { done = true; return }
            if converter == nil { converter = AVAudioConverter(from: buffer.format, to: pcm(22_050)) }
            if let converter, let bytes = converted(buffer, using: converter) {
                data.append(bytes.prefix(maxPlaybackBytes - data.count))
                if data.count >= maxPlaybackBytes { done = true }
            }
        }

        func completed() -> Data? {
            lock.lock()
            defer { lock.unlock() }
            return done ? data : nil
        }
    }

    @MainActor static func speak(_ device: String) throws {
        struct Speech: Decodable { let text: String; let language: String }
        let request = try JSONDecoder().decode(Speech.self, from: readInput(limit: 64_000))
        guard !request.text.isEmpty else { return }
        let synthesizer = AVSpeechSynthesizer()
        let utterance = AVSpeechUtterance(string: request.text)
        utterance.voice = AVSpeechSynthesisVoice(language: request.language == "zh" ? "zh-CN" : "en-US")
        let audio = SpeechBuffer()
        synthesizer.write(utterance) { audio.append($0) }
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let bytes = audio.completed() {
                synthesizer.stopSpeaking(at: .immediate)
                try playPCM(bytes, device: device, rate: 22_050)
                return
            }
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        synthesizer.stopSpeaking(at: .immediate)
        throw NativeFailure("speech_timeout")
    }
}
