# Third-party references and dependency

The optional Windows x64 portable package bundles the official Node.js v24.21.0 executable. Its license and third-party notices are included in `runtime/LICENSE`. The build script downloads the official distribution from https://nodejs.org/dist/v24.21.0/ and verifies its pinned SHA-256. qrcode-terminal and its installed license notices are included in `node_modules/qrcode-terminal`. No Codex executable or user credentials are bundled.

The Weixin adapter was implemented independently against the documented HTTPS interface in Tencent/openclaw-weixin (client source inspected at version 2.4.9). No OpenClaw runtime is installed or bundled. Source and license: https://github.com/Tencent/openclaw-weixin (MIT).

The optional Weixin login display uses qrcode-terminal 0.12.0, installed through npm and pinned in package-lock.json. It includes the QR encoder used to generate a local SVG. Its license notices remain in the installed dependency. Source: https://github.com/gtanner/qrcode-terminal.

Login links are encoded locally. No third-party QR-generation web service receives the login link.

Optional desktop-thread integration invokes the user's installed OpenAI codex-app-tools plugin through its MCP interface (tested with plugin 0.1.5). The plugin runtime is not copied or bundled. It depends on the running desktop App and its supplied local pipe address; this is not a stable public desktop SDK contract.
