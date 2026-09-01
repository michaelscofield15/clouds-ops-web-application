const fs = require('fs');
const path = require('path');

class DockerfileGenerator {
  /**
   * Generates a production-grade Node.js Dockerfile based on Phase 2 analysis metadata
   */
  generate(projectAnalysis = {}) {
    const port = (projectAnalysis.port && projectAnalysis.port.value && projectAnalysis.port.value !== 'unknown')
      ? projectAnalysis.port.value
      : 3000;

    const packageManager = projectAnalysis.packageManager || 'npm';
    const entryPoint = projectAnalysis.entryPoint?.value;

    let installCommand = 'RUN (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)';
    let copyManifests = 'COPY package*.json ./';

    if (packageManager === 'yarn') {
      copyManifests = 'COPY package.json yarn.lock ./';
      installCommand = 'RUN yarn install --production --frozen-lockfile || yarn install --production';
    } else if (packageManager === 'pnpm') {
      copyManifests = 'COPY package.json pnpm-lock.yaml ./';
      installCommand = 'RUN corepack enable && (pnpm install --prod --frozen-lockfile || pnpm install --prod)';
    } else if (packageManager === 'npm') {
      copyManifests = 'COPY package*.json ./';
      installCommand = 'RUN (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)';
    }

    let startCommand = 'CMD ["node", "src/server.js"]';
    if (entryPoint && entryPoint !== 'unknown') {
      startCommand = `CMD ["node", "${entryPoint}"]`;
    } else {
      startCommand = 'CMD ["npm", "start"]';
    }

    return `# =========================================================================
# Production Dockerfile generated automatically by Autonomous DevOps Platform
# =========================================================================
FROM node:20-alpine AS runtime

# Set production environment
ENV NODE_ENV=production
ENV PORT=${port}

# Create app directory
WORKDIR /app

# Copy dependency manifests first for layer caching
${copyManifests}

# Install production dependencies
${installCommand}

# Copy application source code
COPY . .

# Expose application port
EXPOSE ${port}

# Run as non-root node user for container security
USER node

# Start application
${startCommand}
`;
  }

  /**
   * Ensures a standard .dockerignore file exists in the workspace
   */
  ensureDockerignore(projectDir) {
    const dockerignorePath = path.join(projectDir, '.dockerignore');
    if (!fs.existsSync(dockerignorePath)) {
      const defaultIgnores = `node_modules\nnpm-debug.log\n.git\n.gitignore\n.env\n.env.*\n.DS_Store\ndist\ncoverage\nDockerfile*\n.dockerignore\n`;
      fs.writeFileSync(dockerignorePath, defaultIgnores, 'utf8');
    }
  }

  /**
   * Inspects workspace for an existing Dockerfile or generates one
   */
  prepareDockerfile(projectDir, projectAnalysis) {
    this.ensureDockerignore(projectDir);
    const dockerfilePath = path.join(projectDir, 'Dockerfile');

    if (fs.existsSync(dockerfilePath)) {
      const existingContent = fs.readFileSync(dockerfilePath, 'utf8');
      return {
        source: 'existing',
        dockerfilePath,
        content: existingContent
      };
    }

    // Generate new Dockerfile
    const content = this.generate(projectAnalysis);
    fs.writeFileSync(dockerfilePath, content, 'utf8');

    return {
      source: 'generated',
      dockerfilePath,
      content
    };
  }

  /**
   * Creates a backup of the existing Dockerfile before repair attempts
   */
  backupExistingDockerfile(projectDir) {
    const dockerfilePath = path.join(projectDir, 'Dockerfile');
    const backupPath = path.join(projectDir, 'Dockerfile.cloudops-backup');

    if (fs.existsSync(dockerfilePath)) {
      fs.copyFileSync(dockerfilePath, backupPath);
      return backupPath;
    }
    return null;
  }

  /**
   * Attempts a safe repair of a failing Dockerfile by generating a clean standard template
   * while preserving the original in Dockerfile.cloudops-backup
   */
  attemptSafeRepair(projectDir, projectAnalysis) {
    const backupPath = this.backupExistingDockerfile(projectDir);
    const repairedContent = this.generate(projectAnalysis);
    const dockerfilePath = path.join(projectDir, 'Dockerfile');

    fs.writeFileSync(dockerfilePath, repairedContent, 'utf8');

    return {
      repaired: true,
      backupPath,
      content: repairedContent
    };
  }
}

module.exports = new DockerfileGenerator();
