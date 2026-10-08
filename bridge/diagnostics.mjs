import { appendFileSync, existsSync, statSync, renameSync } from 'node:fs';

// Event metadata only: no prompts, paths, account IDs, tokens or raw error messages.
export function createDiagnostics(file) {
  return (event, fields = {}) => {
    try {
      if (!/^[a-z_.]{1,60}$/.test(event)) return;
      const mode = ['desktop', 'independent'].includes(fields.mode) ? fields.mode : undefined;
      const code = Number.isSafeInteger(fields.code) || (typeof fields.code === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(fields.code))
        ? fields.code : undefined;
      if (existsSync(file) && statSync(file).size >= 256 * 1024) renameSync(file, file + '.previous');
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, mode, code }) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch { /* Diagnostic failures must never stop message handling. */ }
  };
}
