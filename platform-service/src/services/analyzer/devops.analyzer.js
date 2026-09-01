const fs = require('fs');
const path = require('path');

/**
 * Scans workspace recursively up to maxDepth to detect DevOps assets
 */
function scanFilesRecursively(dir, maxDepth = 4, currentDepth = 0) {
  if (currentDepth > maxDepth) return [];
  if (!fs.existsSync(dir)) return [];

  let results = [];
  try {
    const list = fs.readdirSync(dir);
    for (const file of list) {
      if (file === 'node_modules' || file === '.git' || file === '__MACOSX') continue;
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          results.push({ type: 'directory', path: fullPath, name: file });
          results = results.concat(scanFilesRecursively(fullPath, maxDepth, currentDepth + 1));
        } else if (stat.isFile()) {
          results.push({ type: 'file', path: fullPath, name: file });
        }
      } catch (e) {
        // Skip unreadable files
      }
    }
  } catch (e) {
    // Skip unreadable directories
  }

  return results;
}

/**
 * Checks if a YAML file looks like a Kubernetes resource manifest
 */
function isKubernetesManifest(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return /apiVersion\s*:\s*[\w./-]+/m.test(content) && /kind\s*:\s*[A-Z]\w+/m.test(content);
  } catch (e) {
    return false;
  }
}

/**
 * Analyzes presence of existing DevOps configuration files
 */
function analyzeDevops(projectDir) {
  const allEntries = scanFilesRecursively(projectDir);
  const fileNames = allEntries.filter((e) => e.type === 'file').map((e) => e.name);
  const dirNames = allEntries.filter((e) => e.type === 'directory').map((e) => e.name);

  // 1. Docker detection
  const hasDockerFile = fileNames.some((f) => /^Dockerfile(?:\.[\w-]+)?$/i.test(f) || f === 'Containerfile');
  const hasDockerCompose = fileNames.some((f) =>
    /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(f)
  );
  const dockerDetected = hasDockerFile || hasDockerCompose;

  // 2. Kubernetes detection
  const hasK8sDir = dirNames.some((d) => d === 'k8s' || d === 'kubernetes');
  const yamlFiles = allEntries.filter((e) => e.type === 'file' && /\.(?:ya?ml)$/i.test(e.name));
  const hasK8sManifest = yamlFiles.some((y) => isKubernetesManifest(y.path));
  const kubernetesDetected = hasK8sDir || hasK8sManifest;

  // 3. Helm detection
  const hasChartYaml = fileNames.some((f) => f === 'Chart.yaml' || f === 'Chart.yml');
  const hasHelmDir = dirNames.some((d) => d === 'helm' || d === 'charts');
  const helmDetected = hasChartYaml || hasHelmDir;

  // 4. CI/CD detection
  const hasGithubWorkflows = allEntries.some(
    (e) => e.path.includes('.github/workflows') || e.path.includes('.github\\workflows')
  );
  const hasJenkinsfile = fileNames.some((f) => /^Jenkinsfile(?:\.[\w-]+)?$/i.test(f));
  const hasGitlabCi = fileNames.some((f) => f === '.gitlab-ci.yml' || f === '.gitlab-ci.yaml');
  const hasAzurePipelines = fileNames.some((f) => /azure-pipelines(?:\.[\w-]+)?\.ya?ml$/i.test(f));
  const hasCircleCi = allEntries.some((e) => e.path.includes('.circleci'));
  const cicdDetected =
    hasGithubWorkflows || hasJenkinsfile || hasGitlabCi || hasAzurePipelines || hasCircleCi;

  // 5. Terraform detection
  const hasTfFiles = fileNames.some((f) => /\.tf$/i.test(f));
  const hasTfDir = dirNames.some((d) => d === 'terraform');
  const terraformDetected = hasTfFiles || hasTfDir;

  return {
    docker: dockerDetected,
    kubernetes: kubernetesDetected,
    helm: helmDetected,
    cicd: cicdDetected,
    terraform: terraformDetected,
    details: {
      dockerFiles: fileNames.filter((f) => /^(?:Dockerfile|docker-compose|compose)/i.test(f)),
      k8sFiles: yamlFiles.filter((y) => isKubernetesManifest(y.path)).map((y) => path.relative(projectDir, y.path)),
      cicdFiles: fileNames.filter((f) =>
        /^(?:Jenkinsfile|\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml)/i.test(f)
      )
    }
  };
}

module.exports = {
  analyzeDevops
};
