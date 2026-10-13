'use strict';

const { execFile } = require('child_process');

/**
 * Runs an external CLI with a hard timeout. Resolves with the captured output
 * whatever the exit code, so each source can decide how to interpret it.
 * Rejects with an Error whose `code === 'ENOENT'` when the binary is not installed.
 *
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runCli(bin, args, { timeoutMs = 240_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
        cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1', ...(env || {}) },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') {
          return reject(error);
        }
        // Node sets `killed` when the timeout fires and it terminates the child.
        const timedOut = Boolean(error && error.killed);
        resolve({
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          timedOut,
        });
      },
    );
    child.stdin && child.stdin.end();
  });
}

module.exports = { runCli };
