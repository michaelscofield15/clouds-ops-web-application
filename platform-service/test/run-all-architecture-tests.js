const { execSync } = require('child_process');

console.log('========================================================================');
console.log('CLOUDOPS SAAS CORE ARCHITECTURE: MASTER VERIFICATION RUNNER');
console.log('========================================================================\n');

const suites = [
  { name: 'Multi-Service Monorepo Topology Analyzer', file: 'test/multiservice-analyzer.test.js' },
  { name: 'CloudOps Local Docker Agent Engine & Pairing', file: 'test/local-agent.test.js' },
  { name: 'Multi-Tenant Boundary Isolation & Zero-Fallback', file: 'test/final-architecture-multitenant.test.js' }
];

let allPassed = true;
const results = [];

for (const suite of suites) {
  console.log(`\n------------------------------------------------------------------------`);
  console.log(`RUNNING: ${suite.name} (${suite.file})`);
  console.log(`------------------------------------------------------------------------`);
  const t0 = Date.now();
  try {
    const out = execSync(`node ${suite.file}`, { encoding: 'utf8', stdio: 'pipe' });
    console.log(out.trim());
    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    results.push({ name: suite.name, status: 'PASSED', duration: `${duration}s` });
  } catch (err) {
    console.error(err.stdout || '');
    console.error(`✖ FAILED: ${err.message}`);
    const duration = ((Date.now() - t0) / 1000).toFixed(2);
    results.push({ name: suite.name, status: 'FAILED', duration: `${duration}s` });
    allPassed = false;
  }
}

console.log('\n========================================================================');
console.log('FINAL EXECUTION SUMMARY');
console.log('========================================================================');
console.table(results);

if (allPassed) {
  console.log('\n✔ ALL ARCHITECTURE AND ISOLATION SUITES PASSED (100% SUCCESS)\n');
  process.exit(0);
} else {
  console.error('\n✖ ONE OR MORE ARCHITECTURE TEST SUITES FAILED\n');
  process.exit(1);
}
