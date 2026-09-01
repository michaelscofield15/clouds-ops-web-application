const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function execGit(args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const repoDir = path.resolve(cwd);
    const gitDir = path.join(repoDir, '.git');

    let fullArgs;
    if (args[0] === 'init') {
      fullArgs = ['init', repoDir];
    } else {
      fullArgs = [`--git-dir=${gitDir}`, `--work-tree=${repoDir}`, ...args];
    }

    // Mask sensitive token in debug/error messages
    const safeArgs = fullArgs.map(arg => typeof arg === 'string' ? arg.replace(/https:\/\/[^@]+@/, 'https://***@') : arg);

    const proc = spawn('git', fullArgs, {
      cwd: repoDir,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // Prevent hanging on interactive prompts
        ...env
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', data => {
      stdout += data.toString();
    });

    proc.stderr.on('data', data => {
      stderr += data.toString();
    });

    proc.on('error', err => {
      reject(new Error(`Failed to execute 'git ${safeArgs.join(' ')}': ${err.message}`));
    });

    proc.on('close', code => {
      if (code !== 0) {
        const sanitizedStderr = stderr.replace(/https:\/\/[^@]+@/g, 'https://***@');
        const err = new Error(`Git command 'git ${safeArgs.join(' ')}' failed with code ${code}: ${sanitizedStderr.trim()}`);
        err.code = code;
        err.stderr = sanitizedStderr.trim();
        return reject(err);
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

class GitClient {
  /**
   * Initializes git repo if not already initialized
   */
  async init(repoDir) {
    const gitDir = path.join(repoDir, '.git');
    if (!fs.existsSync(gitDir)) {
      await execGit(['init'], repoDir);
    }

    // Set default committer identity locally in the project repository
    await execGit(['config', 'user.name', 'Autonomous CloudOps Platform'], repoDir);
    await execGit(['config', 'user.email', 'cloudops@autonomous-platform.local'], repoDir);
  }

  /**
   * Sets or updates origin remote
   */
  async setRemote(repoDir, remoteUrl) {
    try {
      await execGit(['remote', 'get-url', 'origin'], repoDir);
      await execGit(['remote', 'set-url', 'origin', remoteUrl], repoDir);
    } catch {
      await execGit(['remote', 'add', 'origin', remoteUrl], repoDir);
    }
  }

  /**
   * Checks out or creates a branch
   */
  async checkoutBranch(repoDir, branchName) {
    const sanitizedBranch = branchName.trim().replace(/[^a-zA-Z0-9/_.-]/g, '-');
    await execGit(['checkout', '-B', sanitizedBranch], repoDir);
    return sanitizedBranch;
  }

  /**
   * Stages all changes and commits them
   */
  async addAndCommit(repoDir, commitMessage = 'chore: provision application for CloudOps') {
    await execGit(['add', '-A'], repoDir);

    // Check if there are changes to commit
    const status = await execGit(['status', '--porcelain'], repoDir);
    if (!status.stdout) {
      try {
        const { stdout: hash } = await execGit(['rev-parse', 'HEAD'], repoDir);
        return {
          hash,
          message: 'No new changes to commit (working tree clean)',
          alreadyCommitted: true
        };
      } catch {
        // Initial empty repo commit
      }
    }

    await execGit(['commit', '-m', commitMessage], repoDir);
    const { stdout: hash } = await execGit(['rev-parse', 'HEAD'], repoDir);

    return {
      hash,
      message: commitMessage,
      alreadyCommitted: false
    };
  }

  /**
   * Pushes the current branch to authenticated remote
   */
  async push(repoDir, authenticatedRemoteUrl, branchName, force = true) {
    const args = ['push'];
    if (force) {
      args.push('--force');
    }
    args.push(authenticatedRemoteUrl, branchName);

    const result = await execGit(args, repoDir);
    return result;
  }

  /**
   * Retrieves latest commit details
   */
  async getLatestCommit(repoDir) {
    try {
      const { stdout: hash } = await execGit(['rev-parse', 'HEAD'], repoDir);
      const { stdout: msg } = await execGit(['log', '-1', '--pretty=%B'], repoDir);
      const { stdout: author } = await execGit(['log', '-1', '--pretty=%an <%ae>'], repoDir);
      const { stdout: date } = await execGit(['log', '-1', '--pretty=%cI'], repoDir);

      return {
        hash,
        message: msg.trim(),
        author: author.trim(),
        date: date.trim()
      };
    } catch {
      return null;
    }
  }
}

module.exports = new GitClient();
module.exports.GitClient = GitClient;
module.exports.execGit = execGit;
