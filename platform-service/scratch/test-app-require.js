const fs = require('fs');
fs.writeFileSync('./temporary/app-req.txt', 'START APP REQUIRE\n');
const app = require('../src/app');
fs.appendFileSync('./temporary/app-req.txt', 'SUCCESSFULLY REQUIRED APP!\n');
process.exit(0);
