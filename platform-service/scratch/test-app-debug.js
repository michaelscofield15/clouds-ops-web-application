const fs = require('fs');
const statusPath = './temporary/app-debug.log';
function log(msg) { fs.appendFileSync(statusPath, `${msg}\n`); }

fs.writeFileSync(statusPath, 'START APP DEBUG\n');
try {
  log('1. path, express, helmet');
  const path = require('path');
  const express = require('express');
  const helmet = require('helmet');

  log('2. create app');
  const app = express();

  log('3. helmet middleware');
  app.use(helmet({ contentSecurityPolicy: false }));

  log('4. parsers');
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  log('5. static');
  app.use(express.static(path.join(__dirname, '../src/public')));

  log('6. health');
  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  log('7. distRoutes');
  app.use(require('../src/routes/dist.routes'));

  log('8. authRoutes');
  app.use('/api/auth', require('../src/routes/auth.routes'));

  log('9. connectionRoutes');
  app.use('/api/connections', require('../src/routes/connection.routes'));

  log('10. organizationRoutes');
  app.use('/api/organizations', require('../src/routes/organization.routes'));

  log('11. auditRoutes');
  app.use('/api/audit', require('../src/routes/audit.routes'));

  log('12. agentRoutes');
  app.use('/api/agent', require('../src/routes/agent.routes'));

  log('13. githubRoutes');
  app.use('/api/github', require('../src/routes/github.routes'));

  log('14. jenkinsRoutes');
  app.use('/api/jenkins', require('../src/routes/jenkins.routes'));

  log('15. kubernetesRoutes');
  app.use('/api/kubernetes', require('../src/routes/kubernetes.routes'));

  log('16. awsRoutes');
  app.use('/api/aws', require('../src/routes/aws.routes'));

  log('17. terraformController');
  app.get('/api/terraform/status', require('../src/controllers/terraform.controller').getGlobalStatus);

  log('18. selfHealingGlobalRouter');
  app.use('/api/recovery', require('../src/routes/selfHealing.routes').globalRouter);

  log('19. projectRoutes');
  app.use('/api/projects', require('../src/routes/project.routes'));

  log('20. binding listen on 4000');
  const server = app.listen(4000, '0.0.0.0', () => {
    log('21. LISTENING SUCCESSFUL ON 4000');
  });

  server.on('error', err => log('LISTEN ERROR: ' + err.message));
} catch (err) {
  log('FATAL: ' + err.stack);
}
