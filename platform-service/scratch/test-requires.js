const fs = require('fs');

function testReq(name, p) {
  try {
    fs.appendFileSync('./temporary/req-log.txt', `Testing ${name}...\n`);
    require(p);
    fs.appendFileSync('./temporary/req-log.txt', `✔ Loaded ${name}\n`);
  } catch (err) {
    fs.appendFileSync('./temporary/req-log.txt', `✖ Error in ${name}: ${err.stack}\n`);
  }
}

fs.mkdirSync('./temporary', { recursive: true });
fs.writeFileSync('./temporary/req-log.txt', 'START\n');

testReq('distRoutes', '../src/routes/dist.routes');
testReq('authRoutes', '../src/routes/auth.routes');
testReq('connectionRoutes', '../src/routes/connection.routes');
testReq('organizationRoutes', '../src/routes/organization.routes');
testReq('auditRoutes', '../src/routes/audit.routes');
testReq('agentRoutes', '../src/routes/agent.routes');
testReq('githubRoutes', '../src/routes/github.routes');
testReq('jenkinsRoutes', '../src/routes/jenkins.routes');
testReq('kubernetesRoutes', '../src/routes/kubernetes.routes');
testReq('awsRoutes', '../src/routes/aws.routes');
testReq('terraformController', '../src/controllers/terraform.controller');
testReq('selfHealingRoutes', '../src/routes/selfHealing.routes');
testReq('projectRoutes', '../src/routes/project.routes');
testReq('app', '../src/app');
fs.appendFileSync('./temporary/req-log.txt', 'ALL DONE\n');
process.exit(0);
