import Cocoa
import WebKit
import Darwin

private let previewPort = 31416
private let previewURL = URL(string: "http://127.0.0.1:\(previewPort)/?device=iphone16")!

final class PreviewDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var screenView: NSView!
    private var serverProcess: Process?
    private var attempts = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = "Version/18.0 Mobile/15E148 Safari/604.1"
        configuration.userContentController.addUserScript(WKUserScript(
            source: "document.documentElement.dataset.devicePreview='iphone16';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 393, height: 852), configuration: configuration)
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        webView.navigationDelegate = self
        webView.allowsMagnification = false

        let rootView = NSView(frame: NSRect(x: 0, y: 0, width: 437, height: 896))
        rootView.wantsLayer = true
        rootView.layer?.backgroundColor = NSColor(calibratedWhite: 0.82, alpha: 1).cgColor

        let deviceBody = NSView(frame: NSRect(x: 8, y: 8, width: 421, height: 880))
        deviceBody.wantsLayer = true
        deviceBody.layer?.backgroundColor = NSColor(calibratedWhite: 0.055, alpha: 1).cgColor
        deviceBody.layer?.cornerRadius = 59
        deviceBody.layer?.shadowColor = NSColor.black.cgColor
        deviceBody.layer?.shadowOpacity = 0.34
        deviceBody.layer?.shadowRadius = 9
        deviceBody.layer?.shadowOffset = NSSize(width: 0, height: -2)

        screenView = NSView(frame: NSRect(x: 14, y: 14, width: 393, height: 852))
        screenView.wantsLayer = true
        screenView.layer?.cornerRadius = 51
        screenView.layer?.masksToBounds = true
        screenView.layer?.backgroundColor = NSColor.white.cgColor
        webView.autoresizingMask = [.width, .height]
        screenView.addSubview(webView)
        deviceBody.addSubview(screenView)
        rootView.addSubview(deviceBody)

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 437, height: 896),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "株トラ — iPhone 16 Preview"
        window.contentView = rootView
        window.contentMinSize = NSSize(width: 437, height: 896)
        window.contentMaxSize = NSSize(width: 437, height: 896)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let startupAssetURL = Bundle.main.resourceURL?.appendingPathComponent("app/apps/web/public")
        webView.loadHTMLString("""
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
        <style>
        *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;overflow:hidden;padding:16px;background:#f4f4f3;color:#171717;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans",sans-serif;text-align:center}.content{--logo-size:clamp(92px,min(30vw,22vh),132px);width:min(360px,100%);display:grid;grid-template-rows:auto auto auto;gap:clamp(12px,2.5vh,22px);align-items:center;justify-items:center}.logo{width:var(--logo-size);height:var(--logo-size);display:block;border-radius:clamp(20px,6vw,29px);box-shadow:0 18px 42px rgba(12,17,29,.13),0 3px 10px rgba(12,17,29,.08)}.brand strong{display:block;font-size:clamp(28px,min(8vw,6vh),34px);line-height:1.1;letter-spacing:0}.copy p{margin:0;font-size:13px;font-weight:700}.copy small{display:block;margin-top:7px;color:#686868;font-size:9.5px;line-height:1.55}
        </style>
        <main class="content"><img class="logo" src="icon.svg" alt=""><header class="brand"><strong>株トラ</strong></header><div class="copy"><p id="startup-label">プレビューを準備中</p><small id="startup-detail">暗号化データとローカルサーバーを確認しています</small></div></main>
        """, baseURL: startupAssetURL)

        stopStalePreviewServer()
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        if let process = serverProcess, process.isRunning { process.terminate() }
    }

    private func stopStalePreviewServer() {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-tiTCP:\(previewPort)", "-sTCP:LISTEN"]
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        if let value = String(data: data, encoding: .utf8)?.split(separator: "\n").first,
           let pid = Int32(value) {
            kill(pid, SIGTERM)
            usleep(150_000)
        }
    }

    private func startServer() {
        updateStartupStatus("保存データを確認中", "このMacの暗号化ポートフォリオを探しています")
        guard let resources = Bundle.main.resourceURL else { return showError("アプリのリソースを確認できません") }
        let appRoot = resources.appendingPathComponent("app")
        let serverURL = findServer(in: appRoot)
        guard let serverURL else { return showError("ローカルサーバーを確認できません") }
        let vaultURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/株トラ/local-vault.json")
        guard FileManager.default.fileExists(atPath: vaultURL.path) else {
            return showError("暗号化済みのローカルデータを確認できません")
        }
        guard let vaultKey = readKeychainPassword(service: "jp.kabutora.local-vault") else {
            return showError("キーチェーンの暗号鍵を確認できません")
        }

        let process = Process()
        process.executableURL = resources.appendingPathComponent("node")
        process.arguments = [serverURL.path]
        process.currentDirectoryURL = serverURL.deletingLastPathComponent()
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = String(previewPort)
        environment["HOSTNAME"] = "127.0.0.1"
        environment["KABUTORA_LOCAL_VAULT_PATH"] = vaultURL.path
        environment["KABUTORA_LOCAL_VAULT_KEY"] = vaultKey
        process.environment = environment

        let logURL = URL(fileURLWithPath: "/tmp/kabutora-iphone-preview.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let log = try? FileHandle(forWritingTo: logURL) {
            process.standardOutput = log
            process.standardError = log
        }

        do {
            updateStartupStatus("ローカルサーバーを起動中", "株トラのアプリ画面を準備しています")
            try process.run()
            serverProcess = process
            checkServer()
        } catch {
            showError("ローカルサーバーを起動できません")
        }
    }

    private func readKeychainPassword(service: String) -> String? {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        task.arguments = ["find-generic-password", "-s", service, "-a", NSUserName(), "-w"]
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            guard task.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func findServer(in root: URL) -> URL? {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else { return nil }
        var fallback: URL?
        for case let file as URL in enumerator where file.lastPathComponent == "server.js" {
            if file.path.contains("/apps/web/server.js") { return file }
            fallback = fallback ?? file
        }
        return fallback
    }

    private func checkServer() {
        attempts += 1
        var request = URLRequest(url: previewURL)
        request.timeoutInterval = 0.4
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if let http = response as? HTTPURLResponse, http.statusCode < 500 {
                    self.updateStartupStatus("アプリ画面を読み込み中", "表示設定とポートフォリオを反映しています")
                    self.webView.load(URLRequest(url: previewURL, cachePolicy: .reloadIgnoringLocalCacheData))
                } else if self.attempts < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.checkServer() }
                } else {
                    self.showError("ローカルサーバーの応答がありません")
                }
            }
        }.resume()
    }

    private func updateStartupStatus(_ label: String, _ detail: String) {
        let safeLabel = label.replacingOccurrences(of: "'", with: "\\'")
        let safeDetail = detail.replacingOccurrences(of: "'", with: "\\'")
        webView.evaluateJavaScript("document.getElementById('startup-label').textContent='\(safeLabel)';document.getElementById('startup-detail').textContent='\(safeDetail)';")
    }

    private func showError(_ message: String) {
        webView.loadHTMLString("<meta name='viewport' content='width=device-width'><body style='font:14px -apple-system;padding:24px'>\(message)</body>", baseURL: nil)
    }
}

let application = NSApplication.shared
let delegate = PreviewDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
