/**
 * Detects application web framework based on declared dependencies and imports.
 */
function analyzeFramework(nodeInfo = {}) {
  const deps = {
    ...(nodeInfo.dependencies || {}),
    ...(nodeInfo.devDependencies || {})
  };

  if (deps['@nestjs/core'] || deps['@nestjs/common']) {
    return {
      name: 'NestJS',
      version: deps['@nestjs/core'] || deps['@nestjs/common'],
      confidence: 'high'
    };
  }

  if (deps['express']) {
    return {
      name: 'Express',
      version: deps['express'],
      confidence: 'high'
    };
  }

  if (deps['fastify']) {
    return {
      name: 'Fastify',
      version: deps['fastify'],
      confidence: 'high'
    };
  }

  if (deps['koa']) {
    return {
      name: 'Koa',
      version: deps['koa'],
      confidence: 'high'
    };
  }

  if (deps['hono']) {
    return {
      name: 'Hono',
      version: deps['hono'],
      confidence: 'high'
    };
  }

  if (deps['next']) {
    return {
      name: 'Next.js',
      version: deps['next'],
      confidence: 'high'
    };
  }

  if (deps['react'] || deps['react-dom']) {
    return {
      name: deps['vite'] ? 'React (Vite)' : 'React',
      version: deps['react'] || deps['react-dom'],
      confidence: 'high'
    };
  }

  if (deps['vue']) {
    return {
      name: deps['vite'] ? 'Vue (Vite)' : 'Vue.js',
      version: deps['vue'],
      confidence: 'high'
    };
  }

  if (deps['svelte'] || deps['@sveltejs/kit']) {
    return {
      name: 'Svelte',
      version: deps['svelte'] || deps['@sveltejs/kit'],
      confidence: 'high'
    };
  }

  return {
    name: 'Unknown / Unsupported',
    version: null,
    confidence: 'none'
  };
}

module.exports = {
  analyzeFramework
};
