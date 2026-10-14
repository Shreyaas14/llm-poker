// Reads a credential without terminal echo. The ignored local file is owner-only.
import { writeFileSync } from 'node:fs';
if (!process.stdin.isTTY) throw new Error('An interactive terminal is required.');
process.stdin.setRawMode(true);
process.stdout.write('Ready for local key on hidden stdin.\n');
let value = '';
process.stdin.on('data', chunk => {
  const text = chunk.toString();
  if (text.includes('\u0003')) process.exit(1);
  value += text;
  if (/[\r\n]/.test(value)) {
    const key = value.trim();
    if (!/^vck_[A-Za-z0-9_-]+$/.test(key)) {process.stderr.write('Invalid key format.\n');process.exit(1);}
    writeFileSync(new URL('../.dev.vars', import.meta.url), `AI_GATEWAY_API_KEY=${key}\n`, {mode:0o600});
    process.stdin.setRawMode(false);
    process.stdout.write('Local credential stored; value hidden.\n');
    process.exit(0);
  }
});
