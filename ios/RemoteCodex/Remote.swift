import Foundation
import Combine
import Security

struct ChatMessage: Decodable, Identifiable {
    let id: String
    let role: String
    let text: String
}

struct Activity: Decodable, Identifiable {
    let id: String
    let label: String
    let detail: String
    let status: String

    var statusLabel: String {
        ["inProgress": "进行中", "completed": "已完成", "failed": "失败", "declined": "已拒绝"][status] ?? "处理中"
    }
}

struct Question: Decodable, Identifiable {
    struct Option: Decodable { let label: String; let description: String }
    let id: String
    let header: String
    let question: String
    let isSecret: Bool
    let options: [Option]?
}

struct Approval: Decodable, Identifiable {
    let id: String
    let type: String
    let reason: String
    let detail: String
    let cwd: String
    let questions: [Question]

    var title: String {
        switch type {
        case "command": return "允许执行这条命令？"
        case "file": return "允许修改这些文件？"
        case "permissions": return "允许本轮使用这些权限？"
        default: return "Codex 需要你的回答"
        }
    }
}

struct Snapshot: Decodable {
    let epoch: String
    let revision: Int
    let project: String
    let threadId: String?
    let online: Bool
    let busy: Bool
    let turnId: String?
    let access: String
    let status: String
    let messages: [ChatMessage]
    let activity: [Activity]
    let approvals: [Approval]
    let error: String?
}

enum Keychain {
    private static let service = "RemoteCodex.Pairing"
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "bridge"]
    }

    static func read() -> String {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    static func save(_ token: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "无法保存配对密钥 (\(status))"])
        }
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class Remote: ObservableObject {
    @Published var address = UserDefaults.standard.string(forKey: "bridgeURL") ?? ""
    @Published var token = Keychain.read()
    @Published var snapshot: Snapshot?
    @Published var connected = false
    @Published var working = false
    @Published var error: String?
    @Published var draft = UserDefaults.standard.string(forKey: "pendingText") ?? ""

    private var polling: Task<Void, Never>?
    private var generation = UUID()
    private var pendingID = UserDefaults.standard.string(forKey: "pendingID")
    private var pendingText = UserDefaults.standard.string(forKey: "pendingText")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 55
        config.timeoutIntervalForResource = 60
        config.urlCache = nil
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }()

    var paired: Bool { !address.isEmpty && !token.isEmpty }
    var fullAccess: Bool { snapshot?.access == "full" }
    var canAct: Bool { connected && snapshot?.online == true && !working }
    var canSend: Bool { canAct && snapshot?.busy != true && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func baseURL(_ candidate: String? = nil) throws -> URL {
        guard let url = URL(string: (candidate ?? address).trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw NSError(domain: "RemoteCodex", code: 0, userInfo:
                [NSLocalizedDescriptionKey: "请填写 Tailscale Serve 的 HTTPS 地址，例如 https://pc.example.ts.net"])
        }
        return url
    }

    func saveConnection(address newAddress: String, token newToken: String) {
        do {
            _ = try baseURL(newAddress)
            let cleanToken = newToken.trimmingCharacters(in: .whitespacesAndNewlines)
            guard cleanToken.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil else {
                throw NSError(domain: "RemoteCodex", code: 0, userInfo: [NSLocalizedDescriptionKey: "配对密钥应为 64 位十六进制字符。"])
            }
            try Keychain.save(cleanToken)
            address = newAddress.trimmingCharacters(in: .whitespacesAndNewlines)
            token = cleanToken
            UserDefaults.standard.set(address, forKey: "bridgeURL")
            snapshot = nil
            error = nil
            disconnect()
            connect()
        } catch { self.error = error.localizedDescription }
    }

    func connect() {
        guard paired, polling == nil else { return }
        let current = generation
        polling = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let state = self.snapshot
                    let query = state.map { "?after=\($0.revision)&epoch=\($0.epoch)" } ?? ""
                    let incoming = try await self.request("/state" + query)
                    guard !Task.isCancelled, self.generation == current else { return }
                    self.accept(incoming)
                    self.connected = true
                    delay = 1
                } catch {
                    guard !Task.isCancelled, self.generation == current else { return }
                    self.connected = false
                    self.error = error.localizedDescription
                    try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
                    delay = min(delay * 2, 15)
                }
            }
        }
    }

    func disconnect() {
        generation = UUID()
        polling?.cancel()
        polling = nil
        connected = false
    }

    private func accept(_ incoming: Snapshot) {
        if let current = snapshot, current.epoch == incoming.epoch && current.revision > incoming.revision { return }
        snapshot = incoming
        // Transport errors remain visible until a successful action or reconnect.
        if error?.hasPrefix("连接") == true { error = nil }
    }

    private func request(_ path: String, body: [String: Any]? = nil) async throws -> Snapshot {
        let base = try baseURL()
        guard let url = URL(string: path, relativeTo: base)?.absoluteURL else { throw URLError(.badURL) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var timedBody = body
            timedBody["sentAt"] = Int64(Date().timeIntervalSince1970 * 1000)
            if let threadID = snapshot?.threadId { timedBody["expectedThreadId"] = threadID }
            request.httpBody = try JSONSerialization.data(withJSONObject: timedBody)
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch {
            if Task.isCancelled { throw CancellationError() }
            throw NSError(domain: "RemoteCodex", code: 0, userInfo:
                [NSLocalizedDescriptionKey: "连接中断：\(error.localizedDescription)。确认 PC bridge 与 Tailscale 在线。"])
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let details = (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
            throw NSError(domain: "RemoteCodex", code: (response as? HTTPURLResponse)?.statusCode ?? 0,
                          userInfo: [NSLocalizedDescriptionKey: details?["error"] ?? "服务器响应无效。"])
        }
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    private func act(_ path: String, body: [String: Any], success: (() -> Void)? = nil) async {
        guard !working else { return }
        let current = generation
        working = true
        error = nil
        defer { working = false }
        do {
            let incoming = try await request(path, body: body)
            guard generation == current else { return }
            accept(incoming)
            success?()
        } catch { if generation == current { self.error = error.localizedDescription } }
    }

    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        if pendingText != text || pendingID == nil {
            pendingID = UUID().uuidString
            pendingText = text
            UserDefaults.standard.set(pendingID, forKey: "pendingID")
            UserDefaults.standard.set(text, forKey: "pendingText")
        }
        await act("/message", body: ["id": pendingID!, "text": text]) {
            if self.draft.trimmingCharacters(in: .whitespacesAndNewlines) == text { self.draft = "" }
            self.pendingID = nil
            self.pendingText = nil
            UserDefaults.standard.removeObject(forKey: "pendingID")
            UserDefaults.standard.removeObject(forKey: "pendingText")
        }
    }

    func decide(_ approval: Approval, allow: Bool) async {
        await act("/approval", body: ["id": approval.id, "decision": allow ? "allow" : "deny"])
    }

    func answer(_ approval: Approval, answers: [String: String]) async {
        await act("/approval", body: ["id": approval.id, "answers": answers])
    }

    func access(full: Bool) async {
        await act("/access", body: ["mode": full ? "full" : "workspace",
                                    "confirm": full ? "ALLOW_FULL_PC_ACCESS" : ""])
    }

    func stop() async { await act("/interrupt", body: [:]) }
}
