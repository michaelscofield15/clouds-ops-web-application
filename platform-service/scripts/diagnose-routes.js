const routes = [
  './routes/dist.routes',
  './routes/auth.routes',
  './routes/connection.routes',
  './routes/organization.routes',
  './routes/audit.routes',
  './routes/agent.routes',
  './routes/github.routes',
  './routes/jenkins.routes',
  './routes/kubernetes.routes',
  './routes/aws.routes',
  './controllers/terraform.controller',
  './routes/selfHealing.routes',
  './routes/project.routes'
];

for (const r of routes) {
  console.log(`[START] Loading ${r}...`);
  try {
    require(`../src/${r}`);
    console.log(`[PASS] Loaded ${r}`);
  } catch (e) {
    console.error(`[FAIL] ${r}:`, e.message);
  }
}
console.log('[COMPLETE] All routes loaded successfully');
process.exit(0);
