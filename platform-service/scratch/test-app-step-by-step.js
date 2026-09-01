const fs = require('fs');
const fd = fs.openSync('./temporary/app-steps.log', 'w');
function log(msg) {
  fs.writeSync(fd, `${msg}\n`);
}

log('1. Express');
const express = require('express');
const app = express();

log('2. Helmet');
const helmet = require('helmet');
app.use(helmet({ contentSecurityPolicy: false }));

log('3. Body Parsers');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

log('4. Static');
const path = require('path');
app.use(express.static(path.join(__dirname, '../src/public')));

log('5. Health Check');
app.get('/health', (req, res) => res.json({ status: 'healthy' }));

log('6. Dist Routes');
app.use(require('../src/routes/dist.routes'));

log('7. Auth Routes');
app.use('/api/auth', require('../src/routes/auth.routes'));

log('8. Connection Routes');
app.use('/api/connections', require('../src/routes/connection.routes'));

log('9. Organization Routes');
app.use('/api/organizations', require('../src/routes/organization.routes'));

log('10. Audit Routes');
app.use('/api/audit', require('../src/routes/audit.routes'));

log('11. Agent Routes');
app.use('/api/agent', require('../src/routes/agent.routes'));

log('12. GitHub Routes');
app.use('/api/github', require('../src/routes/github.routes'));

log('13. Jenkins Routes');
app.use('/api/jenkins', require('../src/routes/jenkins.routes'));

log('14. Kubernetes Routes');
app.use('/api/kubernetes', require('../src/routes/kubernetes.routes'));

log('15. AWS Routes');
app.use('/api/aws', require('../src/routes/aws.routes'));

log('16. Terraform Controller');
app.get('/api/terraform/status', require('../src/controllers/terraform.controller').getGlobalStatus);

log('17. Self Healing Global Router');
app.use('/api/recovery', require('../src/routes/selfHealing.routes').globalRouter);

log('18. Project Routes');
app.use('/api/projects', require('../src/routes/project.routes'));

log('19. All Middlewares and Routes Successfully Mounted!');
fs.closeSync(fd);
process.exit(0);
