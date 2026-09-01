const path = require('path');
const express = require('express');
const app = express();

app.use(express.static(path.join(__dirname, '../src/public')));
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

const server = app.listen(4000, '0.0.0.0', () => {
  console.log('MINIMAL_SERVER_READY_4000');
});
