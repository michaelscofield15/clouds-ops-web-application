const AdmZip = require('adm-zip');

/**
 * Creates a valid Node.js + Express test project ZIP buffer
 */
function createValidNodeProjectZip() {
  const zip = new AdmZip();

  const packageJson = {
    name: 'test-express-service',
    version: '2.1.0',
    main: 'src/index.js',
    scripts: {
      start: 'node src/index.js',
      test: 'node --test'
    },
    dependencies: {
      express: '^4.18.2'
    },
    devDependencies: {
      supertest: '^6.3.3'
    }
  };

  const indexJs = `
    const express = require('express');
    const app = express();
    const PORT = process.env.PORT || 8080;
    app.get('/', (req, res) => res.send('OK'));
    app.get('/health', (req, res) => res.status(200).json({ status: 'healthy', service: 'test-express-service' }));
    app.listen(PORT, () => console.log('Listening'));
  `;

  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('src/index.js', Buffer.from(indexJs));

  return zip.toBuffer();
}

/**
 * Creates a Fastify + pnpm project ZIP buffer
 */
function createFastifyPnpmZip() {
  const zip = new AdmZip();

  const packageJson = {
    name: 'fastify-api',
    version: '1.0.0',
    main: 'server.js',
    dependencies: {
      fastify: '^4.0.0'
    }
  };

  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('pnpm-lock.yaml', Buffer.from('lockfileVersion: 5.4'));
  zip.addFile('server.js', Buffer.from('const fastify = require("fastify")(); fastify.listen({ port: 5000 });'));

  return zip.toBuffer();
}

/**
 * Creates a project ZIP buffer containing DevOps configurations (Docker, K8s, CI/CD, Terraform)
 */
function createDevopsProjectZip() {
  const zip = new AdmZip();

  const packageJson = {
    name: 'devops-heavy-app',
    version: '1.0.0',
    main: 'app.js',
    dependencies: {
      express: '^4.18.0'
    }
  };

  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('yarn.lock', Buffer.from('# yarn lockfile v1'));
  zip.addFile('app.js', Buffer.from('const app = express(); app.listen(3000);'));
  zip.addFile('Dockerfile', Buffer.from('FROM node:18-alpine\nWORKDIR /app\n'));
  zip.addFile('docker-compose.yml', Buffer.from('version: "3.8"\nservices:\n  app:\n    build: .\n'));
  zip.addFile('k8s/deployment.yaml', Buffer.from('apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\n'));
  zip.addFile('.github/workflows/ci.yml', Buffer.from('name: CI\non: [push]\n'));
  zip.addFile('main.tf', Buffer.from('provider "aws" { region = "us-east-1" }\n'));

  return zip.toBuffer();
}

/**
 * Creates a project ZIP with secrets embedded
 */
function createSecretsProjectZip() {
  const zip = new AdmZip();

  const packageJson = {
    name: 'vulnerable-project',
    dependencies: { express: '^4.18.0' }
  };

  const configJs = `
    module.exports = {
      awsKey: "AKIAIOSFODNN7EXAMPLE",
      slack: "xoxb-1234567890-1234567890123-abcdefghijklmnop"
    };
  `;

  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('config.js', Buffer.from(configJs));
  zip.addFile('.env', Buffer.from('DATABASE_URL=postgres://user:pass@localhost/db\n'));

  return zip.toBuffer();
}

/**
 * Creates a malicious Zip Slip archive buffer targeting parent directory traversal
 */
function createZipSlipBuffer() {
  const zip = new AdmZip();
  zip.addFile('traversal_test.txt', Buffer.from('Malicious payload'));
  const buf = zip.toBuffer();

  // Replace 'traversal_test.txt' with '../traversal_test' in raw archive headers
  const target = Buffer.from('traversal_test.txt');
  const replacement = Buffer.from('../traversal_test');

  let idx = buf.indexOf(target);
  while (idx !== -1) {
    replacement.copy(buf, idx);
    idx = buf.indexOf(target, idx + 1);
  }

  return buf;
}

/**
 * Creates a project ZIP with an intentionally broken Dockerfile
 */
function createBrokenDockerfileProjectZip() {
  const zip = new AdmZip();

  const packageJson = {
    name: 'broken-dockerfile-app',
    version: '1.0.0',
    main: 'server.js',
    dependencies: {
      express: '^4.18.2'
    }
  };

  const serverJs = `
    const express = require('express');
    const app = express();
    app.get('/health', (req, res) => res.json({ status: 'healthy' }));
    app.listen(3000);
  `;

  // Intentionally broken instruction that fails build step immediately
  const brokenDockerfile = `
    FROM node:20-alpine
    RUN echo "Simulated build error" && exit 1
  `;

  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('server.js', Buffer.from(serverJs));
  zip.addFile('Dockerfile', Buffer.from(brokenDockerfile));

  return zip.toBuffer();
}

/**
 * Creates a project ZIP with an existing valid custom Dockerfile
 */
function createExistingDockerfileProjectZip() {
  const zip = new AdmZip();

  const packageJson = {
    name: 'existing-dockerfile-app',
    version: '1.0.0',
    main: 'server.js',
    dependencies: {
      express: '^4.18.2'
    }
  };

  const serverJs = `
    const express = require('express');
    const app = express();
    app.get('/health', (req, res) => res.json({ status: 'healthy', custom: true }));
    app.listen(3000);
  `;

  const validCustomDockerfile = `
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`;

  zip.addFile('package.json', Buffer.from(JSON.stringify(packageJson, null, 2)));
  zip.addFile('server.js', Buffer.from(serverJs));
  zip.addFile('Dockerfile', Buffer.from(validCustomDockerfile));

  return zip.toBuffer();
}

module.exports = {
  createValidNodeProjectZip,
  createFastifyPnpmZip,
  createDevopsProjectZip,
  createSecretsProjectZip,
  createZipSlipBuffer,
  createBrokenDockerfileProjectZip,
  createExistingDockerfileProjectZip
};
