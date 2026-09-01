const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logDir = path.resolve(__dirname, 'temporary');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const out = fs.openSync(path.join(logDir, 'daemon.out.log'), 'a');
const err = fs.openSync(path.join(logDir, 'daemon.err.log'), 'a');

const serverScript = path.resolve(__dirname, 'src/server.js');
const child = spawn(process.execPath, [serverScript], {
  detached: true,
  stdio: ['ignore', out, err],
  cwd: __dirname
});

child.unref();
console.log('Successfully launched CloudOps Platform background daemon with PID:', child.pid);
process.exit(0);
