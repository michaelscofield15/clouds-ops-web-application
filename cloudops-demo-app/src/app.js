const express = require('express');
const helmet = require('helmet');
const healthRoutes = require('./routes/health.routes');
const apiRoutes = require('./routes/api.routes');
const { getRoot } = require('./controllers/api.controller');

const app = express();

// Security middleware
app.use(helmet());

// Body parser with size limits
app.use(express.json({ limit: '100kb' }));

// Application routes
app.get('/', getRoot);
app.use('/health', healthRoutes);
app.use('/api', apiRoutes);

// 404 handler for unknown routes
app.use((req, res, next) => {
  res.status(404).json({
    error: 'Resource not found',
    path: req.originalUrl
  });
});

// Central error handling middleware
app.use((err, req, res, next) => {
  console.error(`[Error] ${err.message}`, err.stack || '');

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 404 ? 'Resource not found' : 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  });
});

module.exports = app;
