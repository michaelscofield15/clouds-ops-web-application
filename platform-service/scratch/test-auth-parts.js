const fs = require('fs');

function testPart(name, p) {
  try {
    fs.appendFileSync('./temporary/auth-parts.txt', `Testing ${name}...\n`);
    require(p);
    fs.appendFileSync('./temporary/auth-parts.txt', `✔ Loaded ${name}\n`);
  } catch (err) {
    fs.appendFileSync('./temporary/auth-parts.txt', `✖ Error in ${name}: ${err.stack}\n`);
  }
}

fs.writeFileSync('./temporary/auth-parts.txt', 'START AUTH PARTS\n');
testPart('authController', '../src/controllers/auth.controller');
testPart('authMiddleware', '../src/middleware/auth.middleware');
testPart('rateLimitMiddleware', '../src/middleware/rateLimit.middleware');
fs.appendFileSync('./temporary/auth-parts.txt', 'ALL AUTH PARTS DONE\n');
process.exit(0);
