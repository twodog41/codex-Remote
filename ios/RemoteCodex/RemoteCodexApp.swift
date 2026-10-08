import SwiftUI

@main
@MainActor
struct RemoteCodexApp: App {
    @StateObject private var remote = Remote()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView(remote: remote)
                .onChange(of: scenePhase) { phase in
                    if phase == .active { remote.connect() }
                    else { remote.disconnect() }
                }
        }
    }
}
