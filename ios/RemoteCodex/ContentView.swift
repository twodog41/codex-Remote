import SwiftUI

@MainActor
struct ContentView: View {
    @ObservedObject var remote: Remote
    @State private var showSettings = false
    @State private var confirmFull = false
    @State private var showActivity = false
    @State private var settingsAddress = ""
    @State private var settingsToken = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                status
                if let error = remote.error ?? remote.snapshot?.error {
                    Text(error).font(.footnote).foregroundColor(.red)
                        .frame(maxWidth: .infinity, alignment: .leading).padding()
                        .accessibilityLabel("错误：\(error)")
                }
                transcript
                if let approval = remote.snapshot?.approvals.first {
                    ApprovalCard(approval: approval, remote: remote, fullAccess: { confirmFull = true })
                        .id(approval.id)
                }
                composer
            }
            .navigationTitle("Codex 遥控器")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showActivity = true } label: { Image(systemName: "list.bullet.rectangle") }
                        .accessibilityLabel("查看执行进度")
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button { showSettings = true } label: { Label("连接设置", systemImage: "network") }
                        if remote.fullAccess {
                            Button { Task { await remote.access(full: false) } } label: { Label("撤回完全访问", systemImage: "lock.fill") }
                                .disabled(!remote.canAct)
                        } else {
                            Button { confirmFull = true } label: { Label("允许 Codex 完全访问 PC", systemImage: "lock.open") }
                                .disabled(!remote.canAct)
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                    .accessibilityLabel("设置和权限")
                }
            }
            .sheet(isPresented: $showSettings) { settings }
            .sheet(isPresented: $showActivity) { activity }
            .alert("允许 Codex 完全访问 PC？", isPresented: $confirmFull) {
                Button("取消", role: .cancel) {}
                Button("允许完全访问", role: .destructive) { Task { await remote.access(full: true) } }
            } message: {
                Text("Codex 将以运行 bridge 的 Windows 用户权限读写文件、联网和执行命令，免除命令与文件审批。当前任务会先停止，再继续未完成的工作。仅限下一轮、最多十分钟；回合结束或到期自动撤回，到期会停止高权限任务。")
            }
            .onAppear {
                if !remote.paired { showSettings = true }
                remote.connect()
            }
        }
    }

    private var status: some View {
        HStack(spacing: 8) {
            Circle().fill(remote.connected && remote.snapshot?.online == true ? Color.green : Color.gray)
                .frame(width: 7, height: 7)
            Text(remote.connected ? remote.snapshot?.status ?? "已连接" : "正在重连")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if remote.fullAccess {
                Button("完全访问 · 撤回") { Task { await remote.access(full: false) } }
                    .font(.caption).tint(.orange).disabled(!remote.canAct)
            } else { Text("项目权限").font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal).padding(.vertical, 10)
            .background(Color(uiColor: .secondarySystemBackground))
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if remote.snapshot?.messages.isEmpty != false {
                        VStack(alignment: .leading, spacing: 10) {
                            Image(systemName: "desktopcomputer").font(.largeTitle)
                            Text("告诉 Codex 要做什么").font(.title3.bold())
                            Text("代码、终端和测试都在 Windows PC 上执行。")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }.padding(.vertical, 40)
                    }
                    ForEach(remote.snapshot?.messages ?? []) { message in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(message.role == "user" ? "你" : "Codex")
                                .font(.caption.bold()).foregroundStyle(.secondary)
                            Text(message.text.isEmpty ? "…" : message.text)
                                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(message.role == "user" ? 12 : 0)
                        .background(message.role == "user" ? Color(uiColor: .secondarySystemBackground) : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    if remote.snapshot?.busy == true {
                        HStack { ProgressView(); Text(remote.snapshot?.activity.last?.label ?? "Codex 正在工作") }
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }.padding()
            }
            .safeAreaInset(edge: .bottom, alignment: .trailing) {
                Button { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } label: {
                    Image(systemName: "arrow.down.circle.fill").font(.title2)
                }.padding(.trailing).accessibilityLabel("查看最新回复")
            }
            .onChange(of: remote.snapshot?.messages.count) { _ in proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 12) {
            TextField("给 Codex 一条指令…", text: $remote.draft, axis: .vertical)
                .lineLimit(1...6).textFieldStyle(.plain).padding(12)
                .background(Color(uiColor: .secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16))
                .accessibilityLabel("自然语言指令")
            if remote.snapshot?.busy == true {
                Button { Task { await remote.stop() } } label: {
                    Image(systemName: "stop.circle.fill").font(.largeTitle)
                }.tint(.red).disabled(!remote.canAct).accessibilityLabel("停止当前任务")
            } else {
                Button { Task { await remote.send() } } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.largeTitle)
                }.disabled(!remote.canSend).accessibilityLabel("发送指令")
            }
        }.padding().background(.bar)
    }

    private var settings: some View {
        NavigationStack {
            Form {
                Section("连接 Windows PC") {
                    TextField("https://pc.example.ts.net", text: $settingsAddress)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .accessibilityLabel("Bridge HTTPS 地址")
                    SecureField("配对密钥", text: $settingsToken)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("保存并连接") { remote.saveConnection(address: settingsAddress, token: settingsToken) }
                        .disabled(remote.working)
                    if remote.connected { Label("已连接", systemImage: "checkmark.circle").foregroundStyle(.green) }
                    if let error = remote.error { Text(error).foregroundStyle(.red).font(.footnote) }
                }
                Section {
                    Text("iPhone 与 PC 登录同一个 Tailscale 网络，使用 PC 上 Tailscale Serve 给出的 HTTPS 地址。密钥保存在本机钥匙串。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if let project = remote.snapshot?.project { Text("当前项目：\(project)").font(.footnote).textSelection(.enabled) }
                }
            }
            .navigationTitle("连接设置")
            .onAppear { settingsAddress = remote.address; settingsToken = remote.token }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showSettings = false } } }
        }
    }

    private var activity: some View {
        NavigationStack {
            List(remote.snapshot?.activity ?? []) { item in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(item.label).font(.headline)
                        Spacer()
                        Text(item.statusLabel).font(.caption).foregroundStyle(.secondary)
                    }
                    if !item.detail.isEmpty { Text(item.detail).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                }.padding(.vertical, 4)
            }
            .navigationTitle("执行进度")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showActivity = false } } }
        }
    }
}

@MainActor
private struct ApprovalCard: View {
    let approval: Approval
    @ObservedObject var remote: Remote
    let fullAccess: () -> Void
    @State private var answers: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(approval.title).font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if !approval.reason.isEmpty { Text(approval.reason).font(.subheadline) }
                    if !approval.detail.isEmpty {
                        Text(approval.detail).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    Text(approval.cwd).font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                    ForEach(approval.questions) { question in
                        Text(question.question).font(.subheadline.bold())
                        ForEach(question.options ?? [], id: \.label) { option in
                            Button {
                                answers[question.id] = option.label
                            } label: {
                                VStack(alignment: .leading) { Text(option.label); Text(option.description).font(.caption) }
                            }
                        }
                        if question.isSecret { SecureField("回答", text: binding(question.id)).textFieldStyle(.roundedBorder) }
                        else { TextField("回答", text: binding(question.id)).textFieldStyle(.roundedBorder) }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: 220)
            if approval.type == "question" {
                Button("发送回答") { Task { await remote.answer(approval, answers: answers) } }
                    .buttonStyle(.borderedProminent)
                    .disabled(!remote.canAct || approval.questions.contains { (answers[$0.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
            } else {
                HStack {
                    Button("拒绝", role: .destructive) { Task { await remote.decide(approval, allow: false) } }
                        .buttonStyle(.bordered)
                    Button("允许这一次") { Task { await remote.decide(approval, allow: true) } }
                        .buttonStyle(.borderedProminent)
                }.disabled(!remote.canAct)
                if !remote.fullAccess {
                    Button("允许 Codex 完全访问 PC", action: fullAccess)
                        .font(.footnote).tint(.orange).disabled(!remote.canAct)
                }
            }
        }.padding().background(Color(uiColor: .tertiarySystemBackground))
    }

    private func binding(_ id: String) -> Binding<String> {
        Binding(get: { answers[id] ?? "" }, set: { answers[id] = $0 })
    }
}
