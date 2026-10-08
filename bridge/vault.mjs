import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const prefix = 'dpapi-current-user:';
const encrypted = new Map(), decrypted = new Map();
export function assertStandardUser() {
  if (process.platform !== 'win32') return;
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const check = '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
  let elevated;
  try { elevated = execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', check], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('无法确认 Windows 权限，未启动遥控。'); }
  if (elevated !== 'False') throw new Error('请用普通权限启动遥控；拒绝以管理员身份运行。');
}
const script = `Add-Type -AssemblyName System.Security
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$entropy = [Text.Encoding]::UTF8.GetBytes('CodeRemote-local-secrets-v1')
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ($request.operation -eq 'protect') {
 $result = [Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($request.data), $entropy, $scope)
} else {
 $result = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($request.data), $entropy, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))`;

function dpapi(operation, bytes) {
  if (process.platform !== 'win32') throw new Error('此凭据保险库需要 Windows DPAPI。');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const result = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: JSON.stringify({ operation, data: bytes.toString('base64') }), encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    return Buffer.from(result.trim(), 'base64');
  } catch { throw new Error('Windows 凭据保护失败，请使用原 Windows 用户重新配对；未降级为明文。'); }
}

export function protect(value) {
  if (typeof value !== 'string' || !value || value.startsWith(prefix)) return value;
  if (!encrypted.has(value)) {
    if (encrypted.size >= 16) encrypted.clear();
    encrypted.set(value, prefix + dpapi('protect', Buffer.from(value)).toString('base64'));
  }
  return encrypted.get(value);
}

export function unprotect(value) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) return value;
  if (!decrypted.has(value)) {
    if (decrypted.size >= 16) decrypted.clear();
    decrypted.set(value, dpapi('unprotect', Buffer.from(value.slice(prefix.length), 'base64')).toString('utf8'));
  }
  return decrypted.get(value);
}

export function savePrivateJSON(path, value) {
  const saved = { ...value };
  for (const name of ['token', 'context']) if (saved[name]) saved[name] = protect(saved[name]);
  writeFileSync(path + '.tmp', JSON.stringify(saved), { mode: 0o600 });
  renameSync(path + '.tmp', path);
}

export function readPrivateJSON(path) {
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  const value = { ...saved };
  let migrate = false;
  for (const name of ['token', 'context']) {
    if (value[name]) {
      migrate ||= !value[name].startsWith(prefix);
      value[name] = unprotect(value[name]);
    }
  }
  if (migrate) savePrivateJSON(path, value);
  return value;
}
