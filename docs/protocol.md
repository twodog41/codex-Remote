# 手机与 bridge 接口

所有接口要求 `Authorization: Bearer <64 位十六进制配对密钥>`。POST 必须是 `application/json`，body 上限 128 KiB。仅 JSON 回复，不开放 CORS；带 Origin 的浏览器请求拒绝。

0.2.1 的 POST 还要求 `sentAt`（发送时 Unix 毫秒时间戳），最多两分钟有效，早于本次启动的请求拒绝。可带 `expectedThreadId`，目标不匹配时拒绝。配对密钥在 PC 配置中用 DPAPI 保存，HTTP 仍使用解密后的 64 位值。独立模式完全访问仅下一轮、最长十分钟；桌面模式不使用这套权限控制。

| 接口 | 请求 | 行为 |
| --- | --- | --- |
| `GET /state` | 无 | 返回完整当前快照 |
| `GET /state?after=N&epoch=UUID` | 最近快照的 revision 与 epoch | 相同版本时等待变化，最多 25 秒；bridge 重启后 epoch 不同，立即恢复快照 |
| `POST /message` | `{"id":"客户端 UUID","text":"自然语言"}` | 空闲时启动一轮；相同 ID 和文字去重 |
| `POST /approval` | `{"id":"快照中的审批 ID","decision":"allow"}` 或 `deny` | 批准或拒绝当前有效请求 |
| `POST /approval` | `{"id":"审批 ID","answers":{"问题ID":"回答"}}` | 回答 Codex 澄清问题 |
| `POST /access` | `{"mode":"full","confirm":"ALLOW_FULL_PC_ACCESS"}` | 明确授权完全访问；正在运行时先停止再继续 |
| `POST /access` | `{"mode":"workspace"}` | 先停止，再撤回完全访问 |
| `POST /interrupt` | `{}` | 等待当前一轮确认停止 |

成功返回当前快照（200）；错误返回 `{"error":"说明"}`。401 是配对失败，403 是浏览器访问，409 是任务忙/请求过期/重复 ID 冲突，503 是 app-server 离线。HTTP 超时不能作为“没有执行”的证据，手机应重新读取快照；消息重试必须保持同一个 ID。

快照包含 `epoch`、单调递增的 `revision`、`project`、`threadId`、`online`、`busy`、`turnId`、`access`、`status`、`messages`、`activity`、`approvals`、`error`。审批 ID 是 bridge 为单次服务端请求生成的随机 UUID，手机不能直接提交任意 RPC 方法或 app-server 请求 ID。

消息结构：`{id, role: "user" | "assistant", text}`。进度结构：`{id, label, detail, status}`。审批结构：`{id, type: "command" | "file" | "permissions" | "question", reason, detail, cwd, questions}`。

bridge 使用 newline-delimited JSON stdio。`initialize` 成功后发送 `initialized`，再 `thread/start` 或 `thread/resume`；监听 item、delta、turn 和 serverRequest/resolved。命令/文件审批答复 `{decision:"accept"|"decline"}`，权限审批答复 `{permissions:已申请的子集,scope:"turn"}`。未识别的请求拒绝。[官方协议](https://learn.chatgpt.com/docs/app-server)
