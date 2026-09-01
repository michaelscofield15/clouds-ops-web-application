const fs = require('fs');

function testPart(name, p) {
  try {
    fs.appendFileSync('./temporary/proj-parts.txt', `Testing ${name}...\n`);
    require(p);
    fs.appendFileSync('./temporary/proj-parts.txt', `✔ Loaded ${name}\n`);
  } catch (err) {
    fs.appendFileSync('./temporary/proj-parts.txt', `✖ Error in ${name}: ${err.stack}\n`);
  }
}

fs.writeFileSync('./temporary/proj-parts.txt', 'START PROJ PARTS\n');
testPart('dockerRoutes', '../src/routes/docker.routes');
testPart('gitController', '../src/controllers/git.controller');
testPart('jenkinsController', '../src/controllers/jenkins.controller');
testPart('kubernetesController', '../src/controllers/kubernetes.controller');
testPart('awsController', '../src/controllers/aws.controller');
testPart('monitoringRoutes', '../src/routes/monitoring.routes');
testPart('terraformRoutes', '../src/routes/terraform.routes');
testPart('orchestratorRoutes', '../src/routes/orchestrator.routes');
fs.appendFileSync('./temporary/proj-parts.txt', 'ALL PROJ PARTS DONE\n');
process.exit(0);
