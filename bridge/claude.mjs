// Runs Claude Code headless with your normal login. No tools, no MCP servers,
// no settings, hooks or plugins, so a call is a plain model call.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_PROMPT } from './prompts.mjs';

const WORKDIR = mkdtempSync(join(tmpdir(), 'research-helper-'));
const TIMEOUT_MS = 8 * 60 * 1000;

export function claudeArgs({ schema, model, stream = false }) {
  const args = [
    '-p',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt', SYSTEM_PROMPT,
    '--model', model,
    ...(stream ? ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'] : ['--output-format', 'json']),
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

// onPartial(jsonSoFar): called (at most every 200 ms) while Claude writes the
// structured output, so callers can show finished parts before the whole answer.
export function runClaude({ prompt, schema, model = 'sonnet', onPartial, bin = process.env.RH_CLAUDE_BIN || 'claude' }) {
  const stream = !!(onPartial && schema);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, claudeArgs({ schema, model, stream }), { cwd: WORKDIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let buf = '';
    let partial = '';
    let lastEmit = 0;
    let pending;
    const emit = () => {
      clearTimeout(pending);
      pending = null;
      lastEmit = Date.now();
      try { onPartial(partial); } catch { /* caller bug must not kill the run */ }
    };
    const onLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'result') out = line;
      const d = ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' ? ev.event.delta : null;
      if (d?.type === 'input_json_delta' && d.partial_json) {
        partial += d.partial_json;
        if (Date.now() - lastEmit > 200) emit();
        else pending ||= setTimeout(emit, 200);
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'tool_use') {
        partial = '';
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Claude took longer than 8 minutes'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      if (!stream) return void (out += d);
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start "${bin}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(pending);
      if (stream && buf) onLine(buf);
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
