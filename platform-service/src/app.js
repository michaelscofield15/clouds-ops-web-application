const path = require('path');
const express = require('express');
const helmet = require('helmet');

const app = express();

// Security headers with relaxed CSP for local static scripts, inline handlers, and Google Identity Services
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        frameSrc: ["'self'", 'https://accounts.google.com'],
        connectSrc: ["'self'", 'https://accounts.google.com'],
        imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com', 'https://lh3.googleusercontent.com'],
        upgradeInsecureRequests: null
      }
    }
  })
);

// Standard parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Lightweight cookie parser
app.use((req, res, next) => {
  req.cookies = req.cookies || {};
  if (req.headers.cookie) {
    req.headers.cookie.split(';').forEach(c => {
      const [key, ...v] = c.trim().split('=');
      if (key) req.cookies[key] = decodeURIComponent(v.join('='));
    });
  }
  next();
});

// Initialize optional MongoDB connection in background
const mongodbService = require('./services/db/mongodb.service');
mongodbService.connect().catch(() => {});

// Serve static frontend UI
app.use(express.static(path.join(__dirname, 'public')));

// Platform Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'platform-service',
    timestamp: new Date().toISOString()
  });
});

const distRoutes = require('./routes/dist.routes');
const authRoutes = require('./routes/auth.routes');
const connectionRoutes = require('./routes/connection.routes');
const organizationRoutes = require('./routes/organization.routes');
const auditRoutes = require('./routes/audit.routes');
const agentRoutes = require('./routes/agent.routes');
const githubRoutes = require('./routes/github.routes');
const jenkinsRoutes = require('./routes/jenkins.routes');
const kubernetesRoutes = require('./routes/kubernetes.routes');
const awsRoutes = require('./routes/aws.routes');
const terraformController = require('./controllers/terraform.controller');
const { globalRouter: selfHealingGlobalRouter } = require('./routes/selfHealing.routes');
const projectRoutes = require('./routes/project.routes');

// Mount Distribution & Installer routes
app.use(distRoutes);

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/jenkins', jenkinsRoutes);
app.use('/api/kubernetes', kubernetesRoutes);
app.use('/api/aws', awsRoutes);
app.get('/api/terraform/status', terraformController.getGlobalStatus);
app.use('/api/recovery', selfHealingGlobalRouter);
app.use('/api/projects', projectRoutes);

// 404 handler for unmatched API routes
app.use('/api/*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.originalUrl
  });
});

// Central error handling middleware
app.use((err, req, res, next) => {
  console.error(`[Platform-Error] ${err.message}`, err.stack || '');

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: statusCode === 400 ? 'Bad Request' : 'Internal Server Error',
    message: err.message || 'An unexpected error occurred'
  });
});

module.exports = app;
