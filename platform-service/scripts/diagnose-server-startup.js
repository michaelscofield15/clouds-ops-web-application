console.log('1. Loading config...');
const config = require('../src/config');
console.log('2. Loading express & helmet...');
const express = require('express');
const helmet = require('helmet');
console.log('3. Loading app...');
const app = require('../src/app');
console.log('4. Starting listen on port 4000...');
const server = app.listen(4000, '0.0.0.0', () => {
  console.log('5. Listening on http://localhost:4000');
  server.close(() => {
    console.log('6. Closed cleanly');
    process.exit(0);
  });
});
server.on('error', err => {
  console.error('Server error:', err);
  process.exit(1);
});
