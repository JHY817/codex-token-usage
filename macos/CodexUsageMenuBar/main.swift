import AppKit
import Combine
import Foundation
import SwiftUI
import WebKit

private let codexBlue = Color(red: 40 / 255.0, green: 102 / 255.0, blue: 247 / 255.0)
private let codexPurple = Color(red: 139 / 255.0, green: 109 / 255.0, blue: 255 / 255.0)
private let nativeWindowBackground = Color(red: 244 / 255.0, green: 246 / 255.0, blue: 249 / 255.0)
private let nativeCardBackground = Color.white
private let nativeInk = Color(red: 32 / 255.0, green: 35 / 255.0, blue: 33 / 255.0)
private let nativeSeparator = Color.primary.opacity(0.10)
private let cardWidth: CGFloat = 390

struct QuotaWindow: Decodable, Identifiable {
    let limitId: String
    let limitName: String?
    let bucket: String
    let usedPercent: Double
    let remainingPercent: Double?
    let windowDurationMins: Int?
    let resetsAt: Double?
    let resetsAtIso: String?

    var id: String { "\(limitId)-\(bucket)" }

    var title: String {
        let name = (limitName?.isEmpty == false) ? limitName! : limitId
        return "\(name) · \(bucket == "primary" ? "主要" : "次要")"
    }

    var durationLabel: String {
        guard let minutes = windowDurationMins else { return "额度窗口" }
        if minutes % (24 * 60) == 0 { return "\(minutes / (24 * 60)) 天窗口" }
        if minutes % 60 == 0 { return "\(minutes / 60) 小时窗口" }
        return "\(minutes) 分钟窗口"
    }

    var resetDate: Date? {
        if let seconds = resetsAt { return Date(timeIntervalSince1970: seconds) }
        guard let resetsAtIso else { return nil }
        return ISO8601DateFormatter().date(from: resetsAtIso)
    }
}

struct QuotaInfo: Decodable {
    let available: Bool
    let source: String?
    let selected: QuotaWindow?
    let windows: [QuotaWindow]
    let error: String?
}

struct TokenTotals: Decodable {
    let tokens: Int64?
    let conversations: Int?
    let toolCalls: Int?
}

struct ModelTokenBreakdown: Decodable {
    let inputTokens: Int64?
    let cachedInputTokens: Int64?
    let cacheTokensKnown: Bool?

    var cacheHitRate: Double? {
        guard cacheTokensKnown == true,
              let inputTokens,
              inputTokens > 0,
              let cachedInputTokens,
              cachedInputTokens >= 0,
              cachedInputTokens <= inputTokens else {
            return nil
        }
        let rate = (Double(cachedInputTokens) / Double(inputTokens)) * 100
        return rate.isFinite ? rate : nil
    }
}

struct ModelUsage: Decodable, Identifiable {
    let id: String
    let label: String
    let tokens: Int64
    let share: Double?
    let breakdown: ModelTokenBreakdown?

    var safeTokens: Int64 { max(0, tokens) }
    var cacheHitRate: Double? { breakdown?.cacheHitRate }
}

struct StatusEnvelope: Decodable {
    let quota: QuotaInfo?
    let todayCredits: Double?
    let creditsAvailable: Bool?
    let creditsError: String?
    let today: TokenTotals?
    let todayTotals: TokenTotals?
    let models: [ModelUsage]?
    let generatedAt: String?
    let dataSource: String?
    let error: String?
}

/// Keeps brand assets independent from the app's current installation path.
/// The menu bar uses the bundled template so macOS can tint it for either
/// menu-bar appearance; the popover prefers ChatGPT's official Codex artwork.
enum CodexIconCatalog {
    static let templateResourceName = "codex-template"
    static let officialResourceNames = [
        "icon-codex-light.png",
        "icon-codex-dark-color.png",
    ]

    static func applicationCandidates(homeDirectory: String = NSHomeDirectory()) -> [String] {
        [
            "/Applications/ChatGPT.app",
            "\(homeDirectory)/Applications/ChatGPT.app",
            "/Applications/Codex.app",
            "\(homeDirectory)/Applications/Codex.app",
        ]
    }

    static func officialIconCandidates(homeDirectory: String = NSHomeDirectory()) -> [String] {
        applicationCandidates(homeDirectory: homeDirectory).flatMap { applicationPath in
            officialResourceNames.map { resourceName in
                "\(applicationPath)/Contents/Resources/\(resourceName)"
            }
        }
    }

    static func loadMenuBarIcon(bundle: Bundle = .main) -> NSImage? {
        guard let url = bundle.url(forResource: templateResourceName, withExtension: "png"),
              let image = NSImage(contentsOf: url) else {
            return nil
        }
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        return image
    }

    static func loadColorIcon(
        fileManager: FileManager = .default,
        iconLoader: (String) -> NSImage? = { NSWorkspace.shared.icon(forFile: $0) },
        homeDirectory: String = NSHomeDirectory(),
    ) -> NSImage? {
        for path in officialIconCandidates(homeDirectory: homeDirectory) {
            guard fileManager.isReadableFile(atPath: path),
                  let image = NSImage(contentsOfFile: path) else { continue }
            image.size = NSSize(width: 22, height: 22)
            return image
        }

        // If the resource names change in a future ChatGPT build, retain a
        // branded application icon before falling back to the SF Symbol cube.
        for path in applicationCandidates(homeDirectory: homeDirectory)
            where fileManager.fileExists(atPath: path) {
            let image = iconLoader(path)
            image?.size = NSSize(width: 22, height: 22)
            if image != nil { return image }
        }
        return nil
    }
}

final class CodexUsageModel: ObservableObject {
    @Published var quota: QuotaInfo?
    @Published var todayCredits: Double?
    @Published var creditsAvailable = false
    @Published var creditsError: String?
    @Published var today: TokenTotals?
    @Published var models: [ModelUsage] = []
    @Published var generatedAt: Date?
    @Published var dataSource = "等待本地同步"
    @Published var statusMessage = "正在启动本地服务…"
    @Published var lastError: String?
    @Published var serverURL: URL?
    @Published var menuBarIcon: NSImage?
    @Published var codexIcon: NSImage?

    private var serverProcess: Process?
    private var serverOutput: String = ""
    private var outputPipe: Pipe?
    private var refreshTimer: Timer?
    private var quotaRetryTimer: Timer?
    private var quotaRetryAttempt = 0
    private var terminationObserver: NSObjectProtocol?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var lastLifecycleRefreshAt: Date?
    private var dataTask: URLSessionDataTask?
    private let isoFormatter = ISO8601DateFormatter()
    private let quotaRetryDelays: [TimeInterval] = [5, 10, 20, 30, 60]

    init() {
        menuBarIcon = CodexIconCatalog.loadMenuBarIcon()
        codexIcon = CodexIconCatalog.loadColorIcon() ?? CodexIconCatalog.loadMenuBarIcon()
        terminationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main,
        ) { [weak self] _ in
            self?.stopServer()
        }
        installLifecycleObservers()
        startServer()
    }

    deinit {
        stopServer()
        if let terminationObserver {
            NotificationCenter.default.removeObserver(terminationObserver)
        }
        for observer in lifecycleObservers {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        lifecycleObservers.removeAll()
    }

    var selectedWindow: QuotaWindow? {
        guard quota?.available == true else { return nil }
        return quota?.selected
    }

    var remainingPercent: Double? {
        guard let selectedWindow else { return nil }
        let raw = selectedWindow.remainingPercent ?? (100 - selectedWindow.usedPercent)
        guard raw.isFinite else { return nil }
        return min(100, max(0, raw))
    }

    func refreshIfStale(maxAge: TimeInterval = 60, now: Date = Date()) {
        guard let generatedAt else {
            refresh(force: true)
            return
        }
        if now.timeIntervalSince(generatedAt) >= maxAge {
            refresh(force: true)
        } else {
            refresh()
        }
    }

    func refresh(force: Bool = false) {
        guard let serverURL else {
            statusMessage = "本地服务启动中…"
            return
        }
        quotaRetryTimer?.invalidate()
        quotaRetryTimer = nil
        var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false)
        components?.path = "/api/status"
        if force { components?.queryItems = [URLQueryItem(name: "refresh", value: "1")] }
        guard let url = components?.url else { return }

        dataTask?.cancel()
        statusMessage = force ? "正在刷新本地数据…" : "正在同步本地数据…"
        dataTask = URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self else { return }
            if let error {
                if (error as NSError).code == NSURLErrorCancelled { return }
                DispatchQueue.main.async {
                    self.statusMessage = "本地服务暂不可用"
                    self.lastError = error.localizedDescription
                    self.scheduleQuotaRetry()
                }
                return
            }
            guard let data, let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                DispatchQueue.main.async {
                    self.statusMessage = "本地服务返回异常"
                    self.lastError = "无法读取本地同步状态"
                    self.scheduleQuotaRetry()
                }
                return
            }
            do {
                let payload = try JSONDecoder().decode(StatusEnvelope.self, from: data)
                DispatchQueue.main.async {
                    if payload.quota?.available == true {
                        self.quota = payload.quota
                        self.resetQuotaRetry()
                    } else {
                        // Keep the last successful window visible through a
                        // transient App Server failure. If no success exists,
                        // retain the unavailable object so its error remains
                        // inspectable in the popover.
                        if self.quota?.available != true, let unavailable = payload.quota {
                            self.quota = unavailable
                        }
                        self.scheduleQuotaRetry()
                    }
                    self.todayCredits = payload.todayCredits
                    self.creditsAvailable = payload.creditsAvailable == true
                    self.creditsError = payload.creditsError
                    self.today = payload.today ?? payload.todayTotals
                    self.models = payload.models ?? []
                    self.generatedAt = payload.generatedAt.flatMap { self.isoFormatter.date(from: $0) }
                    self.dataSource = Self.dataSourceLabel(payload.dataSource)
                    self.lastError = payload.error ?? payload.quota?.error
                    if payload.quota?.available == true {
                        self.statusMessage = payload.error == nil ? "本地同步正常" : "本地数据已同步，额度读取正常"
                    } else if self.quota?.available == true {
                        self.statusMessage = "本地数据已同步，额度读取重试中"
                    } else {
                        self.statusMessage = "本地数据已同步，额度暂不可用"
                    }
                }
            } catch {
                DispatchQueue.main.async {
                    self.statusMessage = "本地服务返回格式异常"
                    self.lastError = error.localizedDescription
                    self.scheduleQuotaRetry()
                }
            }
        }
        dataTask?.resume()
    }

    func stopServer() {
        refreshTimer?.invalidate()
        refreshTimer = nil
        quotaRetryTimer?.invalidate()
        quotaRetryTimer = nil
        quotaRetryAttempt = 0
        dataTask?.cancel()
        dataTask = nil
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        if let serverProcess, serverProcess.isRunning {
            serverProcess.terminate()
        }
        serverProcess = nil
    }

    private func installLifecycleObservers() {
        let applicationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main,
        ) { [weak self] _ in
            self?.refreshAfterLifecycleEvent()
        }
        lifecycleObservers.append(applicationObserver)

        let wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main,
        ) { [weak self] _ in
            self?.refreshAfterLifecycleEvent()
        }
        lifecycleObservers.append(wakeObserver)
    }

    private func refreshAfterLifecycleEvent() {
        guard serverURL != nil else { return }
        let now = Date()
        if let lastLifecycleRefreshAt,
           now.timeIntervalSince(lastLifecycleRefreshAt) < 2 {
            return
        }
        lastLifecycleRefreshAt = now
        // This is an ordinary status request. The server's same-day snapshot
        // prevents a wake event from rescanning local token logs.
        refresh()
    }

    private func scheduleQuotaRetry() {
        guard serverURL != nil, quotaRetryTimer == nil else { return }
        let index = min(quotaRetryAttempt, quotaRetryDelays.count - 1)
        let delay = quotaRetryDelays[index]
        quotaRetryAttempt = min(quotaRetryAttempt + 1, quotaRetryDelays.count - 1)
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.quotaRetryTimer = nil
            self.refresh()
        }
        quotaRetryTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func resetQuotaRetry() {
        quotaRetryTimer?.invalidate()
        quotaRetryTimer = nil
        quotaRetryAttempt = 0
    }

    private func startServer() {
        guard let nodePath = Self.nodePath() else {
            statusMessage = "未找到 Node.js，无法启动本地服务"
            lastError = "请安装 Node.js 22+，或设置 CODEX_NODE_PATH"
            return
        }
        guard let resources = Bundle.main.resourceURL else {
            statusMessage = "安装包缺少资源目录"
            lastError = "App Resources 不可用"
            return
        }
        let scriptURL = resources.appendingPathComponent("server/http.mjs")
        guard FileManager.default.isReadableFile(atPath: scriptURL.path) else {
            statusMessage = "安装包缺少本地服务文件"
            lastError = "server/http.mjs 不在 App Resources 中"
            return
        }
        let uiRoot = resources.appendingPathComponent("ui/dist/client", isDirectory: true)
        guard FileManager.default.fileExists(atPath: uiRoot.path) else {
            statusMessage = "安装包缺少看板资源"
            lastError = "ui/dist/client 不在 App Resources 中"
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [scriptURL.path]
        var environment = ProcessInfo.processInfo.environment
        environment["CODEX_USAGE_UI_ROOT"] = uiRoot.path
        environment["CODEX_USAGE_PORT"] = "0"
        environment["CODEX_USAGE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        // GUI-launched apps do not inherit the interactive shell's PATH. The
        // Codex launcher is a `#!/usr/bin/env node` script, so an absolute
        // CODEX_BIN alone is not enough: its Node directory must also be on
        // PATH or the child exits with 127 before app-server can start.
        let codexPath = Self.codexPath()
        environment["PATH"] = Self.runtimePath(
            current: environment["PATH"],
            nodePath: nodePath,
            codexPath: codexPath,
        )
        if let codexPath {
            environment["CODEX_BIN"] = codexPath
        }
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        outputPipe = stdout
        // Keep the bundled Node host's diagnostics from filling its stderr pipe.
        stderr.fileHandleForReading.readabilityHandler = { handle in
            _ = handle.availableData
        }
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let chunk = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { self?.consumeServerOutput(chunk) }
        }
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard self?.serverProcess === process else { return }
                self?.serverURL = nil
                self?.statusMessage = "本地服务已停止"
            }
        }

        do {
            try process.run()
            serverProcess = process
            statusMessage = "正在启动本地服务…"
            refreshTimer?.invalidate()
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
                self?.refresh()
            }
        } catch {
            statusMessage = "无法启动本地服务"
            lastError = error.localizedDescription
        }
    }

    private func consumeServerOutput(_ chunk: String) {
        serverOutput.append(chunk)
        while let newline = serverOutput.firstIndex(of: "\n") {
            let line = String(serverOutput[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
            serverOutput.removeSubrange(...newline)
            guard line.hasPrefix("CODEX_USAGE_SERVER_READY ") else { continue }
            let payload = String(line.dropFirst("CODEX_USAGE_SERVER_READY ".count))
            guard let data = payload.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let urlString = object["url"] as? String,
                  let url = URL(string: urlString) else {
                statusMessage = "本地服务启动信息无效"
                continue
            }
            serverURL = url
            statusMessage = "正在同步本地数据…"
            refresh()
        }
    }

    private static func nodePath() -> String? {
        let environment = ProcessInfo.processInfo.environment
        var paths: [String] = []
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("runtime/node").path {
            paths.append(bundled)
        }
        if let configured = environment["CODEX_NODE_PATH"], !configured.isEmpty { paths.append(configured) }
        paths.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
        return paths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func codexPath() -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let configured = environment["CODEX_BIN"], !configured.isEmpty {
            return configured
        }
        let home = NSHomeDirectory()
        let candidates = [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "\(home)/.local/bin/codex",
            "\(home)/.cargo/bin/codex",
            "/opt/local/bin/codex",
            "/usr/bin/codex",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func runtimePath(current: String?, nodePath: String, codexPath: String?) -> String {
        var directories = [URL(fileURLWithPath: nodePath).deletingLastPathComponent().path]
        if let codexPath {
            directories.append(URL(fileURLWithPath: codexPath).deletingLastPathComponent().path)
        }
        directories.append(contentsOf: (current ?? "").split(separator: ":").map(String.init))

        var seen = Set<String>()
        return directories.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }

    private static func dataSourceLabel(_ value: String?) -> String {
        switch value {
        case "snapshot": return "本地快照"
        case "local": return "本地实时归因"
        default: return value ?? "本地同步"
        }
    }
}

struct CodexIconView: View {
    @ObservedObject var model: CodexUsageModel
    var size: CGFloat = 16
    var template = false

    var body: some View {
        let icon = template ? model.menuBarIcon : model.codexIcon
        Group {
            if let image = icon {
                Image(nsImage: image)
                    .resizable()
                    .renderingMode(template ? .template : .original)
                    .interpolation(.high)
                    .scaledToFit()
            } else {
                Image(systemName: "cube")
                    .resizable()
                    .scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Codex")
    }
}

struct UsageBar: View {
    let percent: Double?
    var width: CGFloat = 30

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule(style: .continuous).fill(codexBlue.opacity(0.16))
                if let percent, percent.isFinite {
                    let normalized = min(100, max(0, percent)) / 100
                    if normalized > 0 {
                        Capsule(style: .continuous)
                            .fill(codexBlue)
                            .frame(width: proxy.size.width * normalized)
                    }
                }
            }
        }
        .frame(width: width, height: 4)
        .accessibilityLabel(percent.map { "剩余额度 \(Int($0.rounded()))%" } ?? "额度不可用")
    }
}

struct StatusBarLabel: View {
    @ObservedObject var model: CodexUsageModel

    var body: some View {
        HStack(spacing: 4) {
            CodexIconView(model: model, size: 15, template: true)
            Text(model.remainingPercent.map { "\(Int($0.rounded()))%" } ?? "--")
                .font(.system(size: 11, weight: .medium, design: .rounded))
                .monospacedDigit()
        }
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.remainingPercent.map {
            "Codex 剩余额度 \(Int($0.rounded()))%"
        } ?? "Codex 额度不可用")
    }
}

struct QuotaProgress: View {
    let percent: Double
    var height: CGFloat = 7

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule(style: .continuous).fill(codexBlue.opacity(0.16))
                let normalized = min(100, max(0, percent)) / 100
                if normalized > 0 {
                    Capsule(style: .continuous)
                        .fill(codexBlue)
                        .frame(width: proxy.size.width * normalized)
                }
            }
        }
        .frame(height: height)
        .accessibilityLabel("剩余额度 \(Int(percent.rounded()))%")
    }
}

struct ModelUsageChart: View {
    let models: [ModelUsage]

    private var visibleModels: [ModelUsage] {
        models
            .filter { $0.safeTokens > 0 }
            .sorted {
                if $0.safeTokens == $1.safeTokens { return $0.id < $1.id }
                return $0.safeTokens > $1.safeTokens
            }
    }

    private var maximumTokens: Int64 {
        max(1, visibleModels.map(\.safeTokens).max() ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text("今日模型 Token")
                    .font(.system(size: 12, weight: .medium))
                    .accessibilityLabel("今日模型消耗")
                Spacer()
                Text("模型 · 思考档位 / 万 Token")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }

            if visibleModels.isEmpty {
                HStack(spacing: 7) {
                    Image(systemName: "chart.bar.xaxis")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("暂无模型消耗数据")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(visibleModels.enumerated()), id: \.element.id) { index, model in
                        ModelUsageRow(model: model, maximumTokens: maximumTokens, colorIndex: index)
                    }
                }
            }
        }
        .padding(12)
        .background(nativeCardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(nativeSeparator, lineWidth: 1)
        }
    }
}

struct ModelUsageRow: View {
    let model: ModelUsage
    let maximumTokens: Int64
    let colorIndex: Int

    private static let modelColors: [Color] = [
        codexBlue,
        codexPurple,
        Color(red: 74 / 255.0, green: 154 / 255.0, blue: 244 / 255.0),
        Color(red: 178 / 255.0, green: 124 / 255.0, blue: 245 / 255.0),
        Color(red: 56 / 255.0, green: 174 / 255.0, blue: 147 / 255.0),
        Color(red: 226 / 255.0, green: 154 / 255.0, blue: 73 / 255.0),
    ]

    private var rowColor: Color {
        Self.officialModelColor(for: model.id, fallbackIndex: colorIndex)
    }

    private static func officialModelColor(for id: String, fallbackIndex: Int) -> Color {
        guard !id.isEmpty else { return modelColors[fallbackIndex % modelColors.count] }
        var hash: UInt32 = 0
        for unit in id.utf16 {
            hash = hash &* 31 &+ UInt32(unit)
        }
        return modelColors[Int(hash % UInt32(modelColors.count))]
    }

    private var ratio: CGFloat {
        guard maximumTokens > 0 else { return 0 }
        return min(1, CGFloat(model.safeTokens) / CGFloat(maximumTokens))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 7) {
                Circle()
                    .fill(rowColor)
                    .frame(width: 5, height: 5)
                Text(model.label)
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 6)
                HStack(spacing: 5) {
                    Text(Self.tokenLabel(model.safeTokens))
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Text("缓存 \(Self.cacheLabel(model.cacheHitRate))")
                        .font(.system(size: 9, weight: .medium, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .fixedSize(horizontal: true, vertical: false)
            }

            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule(style: .continuous)
                        .fill(Color.primary.opacity(0.09))
                    Capsule(style: .continuous)
                        .fill(rowColor)
                        .frame(width: proxy.size.width * ratio)
                }
            }
            .frame(height: 5)
        }
    }

    private static func tokenLabel(_ value: Int64) -> String {
        let tenThousands = Double(value) / 10_000
        if tenThousands >= 100 {
            return String(format: "%.0f", tenThousands)
        }
        if tenThousands >= 10 {
            return String(format: "%.1f", tenThousands)
        }
        return String(format: "%.2f", tenThousands)
    }

    private static func cacheLabel(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.1f%%", value)
    }
}

struct PopoverActionButtonStyle: ButtonStyle {
    let isHovered: Bool
    let primary: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(primary ? Color.white : (isHovered ? Color.primary : codexBlue.opacity(0.88)))
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(
                backgroundColor(pressed: configuration.isPressed),
                in: Capsule(style: .continuous),
            )
            .overlay {
                Capsule(style: .continuous)
                    .stroke(borderColor(pressed: configuration.isPressed), lineWidth: 1)
            }
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }

    private func backgroundColor(pressed: Bool) -> Color {
        if primary {
            return codexBlue.opacity(pressed ? 0.78 : (isHovered ? 0.90 : 1))
        }
        return Color.primary.opacity(pressed ? 0.12 : (isHovered ? 0.08 : 0.04))
    }

    private func borderColor(pressed: Bool) -> Color {
        if primary {
            return codexBlue.opacity(pressed ? 0.95 : (isHovered ? 0.98 : 0.90))
        }
        return Color.primary.opacity(pressed ? 0.18 : (isHovered ? 0.13 : 0.08))
    }
}

struct SummaryMetric: View {
    let title: String
    let value: String
    let unavailableMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 22, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
            if let unavailableMessage {
                Text(unavailableMessage)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct QuotaPopoverView: View {
    @ObservedObject var model: CodexUsageModel
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismiss) private var dismiss
    @State private var isRefreshHovered = false
    @State private var isDetailHovered = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                CodexIconView(model: model, size: 21)
                Text("Codex 用量")
                    .font(.system(size: 16, weight: .semibold))
                Spacer(minLength: 0)
            }

            Divider().padding(.vertical, 14)

            Group {
                if let selected = model.selectedWindow, let remaining = model.remainingPercent {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Self.windowLabel(for: selected))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                        Text("\(Int(remaining.rounded()))%")
                            .font(.system(size: 34, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(nativeInk)
                        QuotaProgress(percent: remaining)
                        Text(Self.resetDateLabel(for: selected.resetDate))
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    VStack(alignment: .leading, spacing: 7) {
                        Text("当前额度窗口")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                        Text("—")
                            .font(.system(size: 34, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                        UsageBar(percent: nil, width: .infinity)
                        Text("额度暂不可用")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(14)
            .background(nativeCardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(nativeSeparator, lineWidth: 1)
            }

            Divider().padding(.vertical, 14)

            HStack(spacing: 16) {
                if Self.hasCreditValue(model.todayCredits, available: model.creditsAvailable) {
                    SummaryMetric(
                        title: "今日 credits",
                        value: Self.creditLabel(model.todayCredits, available: model.creditsAvailable),
                        unavailableMessage: nil,
                    )
                    Divider()
                        .frame(height: 43)
                }
                SummaryMetric(
                    title: "今日 Token",
                    value: Self.tokenLabel(model.today?.tokens),
                    unavailableMessage: nil,
                )
            }
            .padding(14)
            .background(nativeCardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(nativeSeparator, lineWidth: 1)
            }

            ModelUsageChart(models: model.models)
                .padding(.top, 14)

            Text(model.generatedAt.map { "更新于 \(Self.clockLabel($0))" } ?? "尚未同步")
                .font(.system(size: 10))
                .foregroundStyle(.tertiary)
                .padding(.top, 9)

            HStack(spacing: 10) {
                Button {
                    model.refresh(force: true)
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .buttonStyle(PopoverActionButtonStyle(isHovered: isRefreshHovered, primary: false))
                .onHover { isRefreshHovered = $0 }

                Spacer()

                Button {
                    DashboardWindowPresenter.openFromPopover(
                        dismissPopover: { dismiss() },
                        openWindow: { openWindow(id: DashboardWindowPresenter.sceneID) },
                    )
                } label: {
                    Text("打开详情")
                }
                .buttonStyle(PopoverActionButtonStyle(isHovered: isDetailHovered, primary: true))
                .onHover { isDetailHovered = $0 }
            }
            .padding(.top, 16)
        }
        .padding(22)
        .frame(width: cardWidth)
        .background(nativeWindowBackground, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(nativeSeparator, lineWidth: 1)
        }
        .onAppear {
            model.refreshIfStale()
        }
    }

    private static func hasCreditValue(_ value: Double?, available: Bool) -> Bool {
        guard available, let value else { return false }
        return value.isFinite
    }

    private static func creditLabel(_ value: Double?, available: Bool) -> String {
        guard hasCreditValue(value, available: available), let value else { return "未提供" }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 1
        formatter.minimumFractionDigits = value.rounded() == value ? 0 : 1
        return formatter.string(from: NSNumber(value: value)) ?? "未提供"
    }

    private static func tokenLabel(_ value: Int64?) -> String {
        guard let value else { return "--" }
        let tenThousands = Int64((Double(max(0, value)) / 10_000).rounded())
        let formatted = NumberFormatter.localizedString(from: NSNumber(value: tenThousands), number: .decimal)
        return "\(formatted) 万"
    }

    private static func windowLabel(for window: QuotaWindow) -> String {
        if let minutes = window.windowDurationMins, minutes > 0,
           minutes % (24 * 60) == 0 {
            return "\(minutes / (24 * 60)) 日额度剩余"
        }
        return window.title
    }

    private static func resetDateLabel(for date: Date?) -> String {
        guard let date else { return "重置时间未知" }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = "M月d日 HH:mm"
        return "\(formatter.string(from: date)) 重置"
    }

    private static func clockLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}

struct DashboardWebView: NSViewRepresentable {
    let url: URL?

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let nativeWindowScript = WKUserScript(
            source: """
            (() => {
              const css = `
                .window-dots { visibility: hidden !important; pointer-events: none !important; }
                html, body { background: #f4f6f9 !important; }
                .app-shell, .app-shell.is-native {
                  padding: 0 !important;
                  min-height: 100vh !important;
                  background: #f4f6f9 !important;
                }
                .dashboard-window, .app-shell.is-native .dashboard-window {
                  min-height: 100vh !important;
                  border-radius: 0 !important;
                  border: 0 !important;
                  background: #f4f6f9 !important;
                  box-shadow: none !important;
                  backdrop-filter: none !important;
                }
                .topbar {
                  background: #ffffff !important;
                  border-bottom: 1px solid #e5e7eb !important;
                  box-shadow: none !important;
                  backdrop-filter: none !important;
                }
                .summary-block, .insights-grid, .conversation-section {
                  background: #ffffff !important;
                  border-color: #e5e7eb !important;
                  box-shadow: none !important;
                  backdrop-filter: none !important;
                }
                .model-breakdown {
                  background: #f8fafc !important;
                  box-shadow: none !important;
                  backdrop-filter: none !important;
                }
                .range-tabs, .task-search, .metric-toggle, .detail-metric-toggle {
                  background: #f4f6f9 !important;
                  box-shadow: none !important;
                  backdrop-filter: none !important;
                }
                .chart-summary-card, .detail-dialog {
                  background: #ffffff !important;
                  box-shadow: 0 6px 18px rgba(31, 35, 40, 0.08) !important;
                  backdrop-filter: none !important;
                }
              `;
              const install = () => {
                if (document.getElementById('codex-native-window-style')) return;
                const style = document.createElement('style');
                style.id = 'codex-native-window-style';
                style.textContent = css;
                document.head?.appendChild(style);
              };
              document.documentElement.dataset.codexNativeWindow = 'true';
              if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', install, { once: true });
              } else {
                install();
              }
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true,
        )
        configuration.userContentController.addUserScript(nativeWindowScript)
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.setValue(true, forKey: "drawsBackground")
        view.underPageBackgroundColor = .windowBackgroundColor
        view.navigationDelegate = context.coordinator
        if let url {
            let nativeURL = Self.nativeURL(url)
            view.load(URLRequest(url: nativeURL))
            context.coordinator.loadedURL = nativeURL
        }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        guard let url else { return }
        let nativeURL = Self.nativeURL(url)
        guard context.coordinator.loadedURL != nativeURL else { return }
        view.load(URLRequest(url: nativeURL))
        context.coordinator.loadedURL = nativeURL
    }

    private static func nativeURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var queryItems = components.queryItems ?? []
        queryItems.removeAll { $0.name == "native" }
        queryItems.append(URLQueryItem(name: "native", value: "1"))
        components.queryItems = queryItems
        return components.url ?? url
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var loadedURL: URL?
    }
}

/// The SwiftUI scene creates the NSWindow lazily. Keep opening and focusing it
/// in one helper so the popover and QA bootstrap use the same behavior.
enum DashboardWindowPresenter {
    static let sceneID = "dashboard"
    static let windowIdentifier = NSUserInterfaceItemIdentifier("com.codex.token-usage-insights.dashboard")
    static let windowTitle = "Codex Token Usage"

    static func configure(_ window: NSWindow) {
        window.identifier = windowIdentifier
        window.isOpaque = true
        window.backgroundColor = .windowBackgroundColor
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
        window.titlebarSeparatorStyle = .none
        // The dashboard uses a full-size title bar. Let the
        // native window move when the user drags its background, including
        // areas occupied by the embedded WKWebView.
        window.isMovableByWindowBackground = true
        window.standardWindowButton(.closeButton)?.isHidden = false
        window.standardWindowButton(.miniaturizeButton)?.isHidden = false
        window.standardWindowButton(.zoomButton)?.isHidden = false
    }

    static func window(in windows: [NSWindow]) -> NSWindow? {
        windows.first { $0.identifier == windowIdentifier }
            ?? windows.first { $0.title == windowTitle }
    }

    static func bringToFront(
        _ window: NSWindow,
        activate: () -> Void = { NSApp.activate(ignoringOtherApps: true) },
    ) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        activate()
        window.orderFrontRegardless()
        window.makeKeyAndOrderFront(nil)
    }

    static func openAndFocus(
        openWindow: @escaping () -> Void,
        windows: @escaping () -> [NSWindow] = { NSApp.windows },
        activate: @escaping () -> Void = { NSApp.activate(ignoringOtherApps: true) },
        attempts: Int = 40,
    ) {
        openWindow()
        focusWhenAvailable(windows: windows, activate: activate, remaining: attempts)
    }

    static func openFromPopover(
        dismissPopover: @escaping () -> Void,
        openWindow: @escaping () -> Void,
        windows: @escaping () -> [NSWindow] = { NSApp.windows },
        activate: @escaping () -> Void = { NSApp.activate(ignoringOtherApps: true) },
        attempts: Int = 40,
    ) {
        // Capture the transient menu-bar window before dismissing SwiftUI's
        // environment. The detail window is identified explicitly so an
        // already-open dashboard is never ordered out by this action.
        let popoverWindow = NSApp.keyWindow
        dismissPopover()
        if let popoverWindow, popoverWindow.identifier != windowIdentifier {
            popoverWindow.orderOut(nil)
        }
        openAndFocus(
            openWindow: openWindow,
            windows: windows,
            activate: activate,
            attempts: attempts,
        )
    }

    private static func focusWhenAvailable(
        windows: @escaping () -> [NSWindow],
        activate: @escaping () -> Void,
        remaining: Int,
    ) {
        DispatchQueue.main.async {
            if let window = Self.window(in: windows()) {
                Self.bringToFront(window, activate: activate)
                return
            }
            guard remaining > 0 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                Self.focusWhenAvailable(windows: windows, activate: activate, remaining: remaining - 1)
            }
        }
    }
}

/// Applies native AppKit title-bar behavior and a solid window background to
/// the SwiftUI-created window. The actual close/minimize/zoom controls remain
/// AppKit's standard buttons; no HTML traffic-light substitutes are used.
struct NativeWindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        Self.configure(view)
        view.appearance = NSAppearance(named: .aqua)
        view.setContentHuggingPriority(.required, for: .horizontal)
        view.setContentHuggingPriority(.required, for: .vertical)
        DispatchQueue.main.async { Self.configure(view.window) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        Self.configure(view)
        view.appearance = NSAppearance(named: .aqua)
        DispatchQueue.main.async { Self.configure(view.window) }
    }

    private static func configure(_ view: NSView) {
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    private static func configure(_ window: NSWindow?) {
        guard let window else { return }
        DashboardWindowPresenter.configure(window)
    }
}

/// A small native drag surface keeps the dashboard window movable even when
/// the full-size WKWebView consumes mouse events over the transparent title
/// bar. It intentionally starts to the right of the traffic-light controls
/// and ends before the web view's top navigation controls.
final class NativeWindowDragView: NSView {
    override var isOpaque: Bool { false }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}

struct NativeWindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> NativeWindowDragView {
        NativeWindowDragView(frame: .zero)
    }

    func updateNSView(_ view: NativeWindowDragView, context: Context) {}
}

struct DashboardWindowView: View {
    @ObservedObject var model: CodexUsageModel

    var body: some View {
        ZStack(alignment: .topLeading) {
            NativeWindowConfigurator()
                .allowsHitTesting(false)

            Group {
                if let serverURL = model.serverURL {
                    DashboardWebView(url: serverURL)
                } else {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text(model.statusMessage)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            // Cover the native 60px top bar, but start past the traffic lights
            // and end before the centered web navigation controls.
            NativeWindowDragRegion()
                .frame(width: 320, height: 60)
                .offset(x: 84, y: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // The AppKit window is configured with fullSizeContentView. Ignore
        // SwiftUI's title-bar safe-area inset so the web topbar shares the
        // same row as the real traffic-light controls.
        .ignoresSafeArea(.container, edges: .top)
        .frame(minWidth: 980, minHeight: 760)
    }
}

struct QAWindowBootstrap: View {
    @Environment(\.openWindow) private var openWindow
    @State private var opened = false

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onAppear {
                let launchRequested = CommandLine.arguments.contains("--qa-open-dashboard")
                    || ProcessInfo.processInfo.environment["CODEX_USAGE_QA_OPEN_DASHBOARD"] == "1"
                guard !opened, launchRequested else { return }
                opened = true
                DashboardWindowPresenter.openAndFocus {
                    openWindow(id: DashboardWindowPresenter.sceneID)
                }
            }
    }
}

@main
struct CodexUsageMenuBarApp: App {
    @StateObject private var model = CodexUsageModel()

    var body: some Scene {
        MenuBarExtra {
            QuotaPopoverView(model: model)
        } label: {
            StatusBarLabel(model: model)
                .background(QAWindowBootstrap())
        }
        .menuBarExtraStyle(.window)

        Window("Codex Token Usage", id: "dashboard") {
            DashboardWindowView(model: model)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1060, height: 930)
    }
}
