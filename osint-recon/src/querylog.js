'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Appends one JSON line per search to a local file. The page footer promises that
 * all queries are logged locally, so this must not be disabled silently.
 * Failures are reported to stderr and never break the search response.
 */
function createQueryLogger(logFile) {
  let dirReady = false;

  return async function logQuery(entry) {
    try {
      if (!dirReady) {
        await fs.promises.mkdir(path.dirname(logFile), { recursive: true });
        dirReady = true;
      }
      const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
      await fs.promises.appendFile(logFile, line, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      console.error(`[querylog] failed to write ${logFile}: ${err.message}`);
    }
  };
}

module.exports = { createQueryLogger };
