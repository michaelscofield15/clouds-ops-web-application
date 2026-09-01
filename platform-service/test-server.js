// DB service diagnostic with env override
process.env.DB_BASE_DIR = '/tmp/cloudops-db';
const fs = require('fs');
const path = require('path');
const logFile = '/tmp/db-diag2.txt';
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\n';
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
}

fs.writeFileSync(logFile, 'DB DIAG2 START\n');
log('DB_BASE_DIR env = ' + process.env.DB_BASE_DIR);

const dbDir = '/tmp/cloudops-db';
log('checking /tmp/cloudops-db files:');
const files = fs.readdirSync(dbDir);
log('files: ' + files.join(','));

log('reading each file:');
for (const f of files) {
  const fp = path.join(dbDir, f);
  log('reading: ' + f);
  const data = fs.readFileSync(fp, 'utf8');
  log('OK: ' + f + ' size=' + data.length);
}

log('loading db.service...');
const db = require('./src/services/db/db.service');
log('OK: db.service, collections: ' + db.collectionNames.join(','));

process.exit(0);
