// Runs Claude Code headless with your normal login. No tools, no MCP servers,
// no settings, hooks or plugins, so a call is a plain model call.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_PROMPT } from './prompts.mjs';

const WORKDIR = mkdtempSync(join(tmpdir(), 'research-helper-'));
const TIMEOUT_MS = 8 * 60 * 1000;

export function claudeArgs({ schema, model }) {
  const args = [
    '-p',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', SYSTEM_PROMPT,
    '--model', model,
    '--output-format', 'json',
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

export function runClaude({ prompt, schema, model = 'sonnet', bin = process.env.RH_CLAUDE_BIN || 'claude' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, claudeArgs({ schema, model }), { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude took longer than 8 minutes'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start "${bin}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`));
      }
      if (res.is_error) return reject(new Error(`claude error: ${String(res.result || res.subtype).slice(0, 400)}`));
      if (schema) {
        if (res.structured_output) return resolve(res.structured_output);
        try {
          return resolve(JSON.parse(res.result));
        } catch {
          return reject(new Error('claude did not return JSON'));
        }
      }
      resolve(String(res.result || '').trim());
    });
    child.stdin.end(prompt);
  });
}
