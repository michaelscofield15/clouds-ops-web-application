const fs = require('fs');
const path = require('path');

/**
 * Inspects package.json to detect Node.js metadata, dependencies, scripts, and runtime information.
 */
function analyzeNode(projectDir) {
  const pkgPath = path.join(projectDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    return {
      isNode: false,
      reason: 'No package.json found'
    };
  }

  let pkgContent;
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    pkgContent = JSON.parse(raw);
  } catch (err) {
    return {
      isNode: true,
      error: `Malformed package.json: ${err.message}`,
      packageJson: null
    };
  }

  const dependencies = pkgContent.dependencies || {};
  const devDependencies = pkgContent.devDependencies || {};
  const scripts = pkgContent.scripts || {};

  return {
    isNode: true,
    name: pkgContent.name || path.basename(projectDir),
    version: pkgContent.version || '1.0.0',
    description: pkgContent.description || '',
    main: pkgContent.main || null,
    engines: pkgContent.engines || {},
    scripts,
    dependencies,
    devDependencies,
    productionCount: Object.keys(dependencies).length,
    developmentCount: Object.keys(devDependencies).length,
    productionList: Object.keys(dependencies),
    developmentList: Object.keys(devDependencies)
  };
}

module.exports = {
  analyzeNode
};
