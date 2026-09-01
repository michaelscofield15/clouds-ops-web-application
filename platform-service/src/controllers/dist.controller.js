const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const config = require('../config');

const AGENT_FILE_PATH = path.resolve(__dirname, '../../bin/cloudops-agent');
const AGENT_VERSION = '1.0.0';
const MIN_NODE_VERSION = '18.0.0';

function getAgentChecksum() {
  if (!fs.existsSync(AGENT_FILE_PATH)) return '';
  const content = fs.readFileSync(AGENT_FILE_PATH);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function resolveServerUrl(req) {
  if (config.publicBaseUrl && !config.publicBaseUrl.includes('localhost')) {
    return config.publicBaseUrl.replace(/\/+$/, '');
  }
  const host = req.get('host') || `localhost:${config.port || 4000}`;
  const protocol = req.protocol || 'http';
  return `${protocol}://${host}`;
}

/**
 * Controller for distributing and serving the standalone CloudOps Local Agent CLI,
 * release version metadata, and dynamic shell / PowerShell installer scripts.
 */
class DistController {
  /**
   * GET /api/agent/dist/version
   * Returns current agent release metadata, minimum Node version, and SHA-256 checksum
   */
  async getReleaseVersion(req, res) {
    try {
      const serverUrl = resolveServerUrl(req);
      const checksum = getAgentChecksum();

      return res.status(200).json({
        version: AGENT_VERSION,
        minNodeVersion: MIN_NODE_VERSION,
        checksums: {
          'cloudops-agent': checksum
        },
        downloadUrl: `${serverUrl}/api/agent/dist/cloudops-agent`,
        installUrl: `${serverUrl}/install.sh`,
        windowsInstallUrl: `${serverUrl}/install.ps1`,
        releaseNotes: 'CloudOps Standalone Local Docker Agent - Production Release with zero-dependency runtime'
      });
    } catch (err) {
      return res.status(500).json({ error: 'DistError', message: err.message });
    }
  }

  /**
   * GET /api/agent/dist/cloudops-agent
   * Streams the raw standalone executable agent script
   */
  async downloadAgentBinary(req, res) {
    try {
      if (!fs.existsSync(AGENT_FILE_PATH)) {
        return res.status(404).json({ error: 'NotFound', message: 'Agent executable not found on server' });
      }

      const stat = fs.statSync(AGENT_FILE_PATH);
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', 'attachment; filename="cloudops-agent"');
      res.setHeader('X-Agent-Version', AGENT_VERSION);
      res.setHeader('X-Agent-Checksum-SHA256', getAgentChecksum());

      const stream = fs.createReadStream(AGENT_FILE_PATH);
      return stream.pipe(res);
    } catch (err) {
      return res.status(500).json({ error: 'DistError', message: err.message });
    }
  }

  /**
   * GET /install.sh
   * Generates and serves a POSIX-compliant installation script for macOS & Linux
   */
  async serveUnixInstaller(req, res) {
    const serverUrl = resolveServerUrl(req);
    const checksum = getAgentChecksum();

    const script = `#!/usr/bin/env sh
# CloudOps Local Agent Official Unix/macOS Installer
set -e

CLOUDOPS_SERVER="${serverUrl}"
EXPECTED_SHA256="${checksum}"
CLOUDOPS_HOME="\${HOME}/.cloudops"
INSTALL_DIR="\${CLOUDOPS_HOME}/bin"
AGENT_PATH="\${INSTALL_DIR}/cloudops-agent"

echo "============================================================"
echo " CloudOps Local Docker Agent Installer"
echo "============================================================"
echo ""

# 1. Check OS & Architecture
OS="$(uname -s)"
ARCH="$(uname -m)"
echo "▶ Detecting System: \${OS} (\${ARCH})..."

case "\${OS}" in
  Darwin|Linux)
    ;;
  *)
    echo "✖ Unsupported operating system: \${OS}. CloudOps Agent requires macOS, Linux, or Windows."
    exit 1
    ;;
esac

# 2. Check Node.js Runtime
echo "▶ Checking Node.js runtime..."
if ! command -v node >/dev/null 2>&1; then
  echo "✖ Node.js is not installed or not found in PATH."
  echo "  Please install Node.js (v18.0.0 or higher) from https://nodejs.org/"
  exit 1
fi

NODE_VER="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "\${NODE_VER}" | cut -d. -f1)"
if [ "\${NODE_MAJOR}" -lt 18 ]; then
  echo "✖ Node.js v\${NODE_VER} detected. CloudOps Agent requires Node.js v18.0.0 or higher."
  echo "  Please upgrade Node.js from https://nodejs.org/"
  exit 1
fi
echo "✔ Found Node.js v\${NODE_VER}"

# 3. Create Safe Installation Directories
echo "▶ Preparing installation directory at \${INSTALL_DIR}..."
mkdir -p "\${INSTALL_DIR}"
chmod 755 "\${CLOUDOPS_HOME}"
chmod 755 "\${INSTALL_DIR}"

# 4. Download Standalone Agent Binary
DOWNLOAD_URL="\${CLOUDOPS_SERVER}/api/agent/dist/cloudops-agent"
TEMP_FILE="\${INSTALL_DIR}/cloudops-agent.tmp"

echo "▶ Downloading CloudOps Agent from \${DOWNLOAD_URL}..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "\${DOWNLOAD_URL}" -o "\${TEMP_FILE}"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "\${TEMP_FILE}" "\${DOWNLOAD_URL}"
else
  echo "✖ Neither curl nor wget is available. Please install curl or wget."
  exit 1
fi

# 5. Verify Integrity Checksum (if shasum/sha256sum available)
if [ -n "\${EXPECTED_SHA256}" ]; then
  echo "▶ Verifying cryptographic SHA-256 checksum..."
  ACTUAL_SHA256=""
  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(sha256sum "\${TEMP_FILE}" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_SHA256="$(shasum -a 256 "\${TEMP_FILE}" | cut -d' ' -f1)"
  fi

  if [ -n "\${ACTUAL_SHA256}" ]; then
    if [ "\${ACTUAL_SHA256}" != "\${EXPECTED_SHA256}" ]; then
      echo "✖ Integrity verification failed!"
      echo "  Expected: \${EXPECTED_SHA256}"
      echo "  Actual:   \${ACTUAL_SHA256}"
      rm -f "\${TEMP_FILE}"
      exit 1
    fi
    echo "✔ SHA-256 Checksum verified: \${ACTUAL_SHA256}"
  fi
fi

# 6. Finalize Binary
mv -f "\${TEMP_FILE}" "\${AGENT_PATH}"
chmod 755 "\${AGENT_PATH}"

# 7. Configure PATH in Shell Profile
add_to_path() {
  PROFILE_FILE="\$1"
  if [ -f "\${PROFILE_FILE}" ]; then
    if ! grep -q 'cloudops/bin' "\${PROFILE_FILE}"; then
      echo '' >> "\${PROFILE_FILE}"
      echo '# CloudOps Agent CLI' >> "\${PROFILE_FILE}"
      echo 'export PATH="$HOME/.cloudops/bin:$PATH"' >> "\${PROFILE_FILE}"
      echo "✔ Added \${INSTALL_DIR} to \${PROFILE_FILE}"
    fi
  fi
}

# Update detected profiles
add_to_path "\${HOME}/.zshrc"
add_to_path "\${HOME}/.bashrc"
add_to_path "\${HOME}/.bash_profile"
add_to_path "\${HOME}/.profile"

# Export for current subshell check
export PATH="\${INSTALL_DIR}:\${PATH}"

echo ""
echo "============================================================"
echo "✔ CloudOps Local Agent installed successfully!"
echo "============================================================"
echo ""
echo "Executable Path: \${AGENT_PATH}"
echo "Version:         $(\${AGENT_PATH} --version 2>/dev/null || echo 'v1.0.0')"
echo ""
echo "To pair your machine with CloudOps, run:"
echo ""
echo "  export PATH=\"\\$HOME/.cloudops/bin:\\$PATH\""
echo "  cloudops-agent connect --code <PAIRING_CODE> --server ${serverUrl}"
echo ""
`;

    res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
    return res.send(script);
  }

  /**
   * GET /install.ps1
   * Generates and serves a PowerShell installation script for Windows
   */
  async serveWindowsInstaller(req, res) {
    const serverUrl = resolveServerUrl(req);
    const checksum = getAgentChecksum();

    const script = `# CloudOps Local Agent Official Windows PowerShell Installer
$ErrorActionPreference = 'Stop'

$CloudOpsServer = "${serverUrl}"
$ExpectedSha256 = "${checksum}"
$CloudOpsHome = Join-Path $env:USERPROFILE ".cloudops"
$InstallDir = Join-Path $CloudOpsHome "bin"
$AgentScriptPath = Join-Path $InstallDir "cloudops-agent.js"
$AgentCmdPath = Join-Path $InstallDir "cloudops-agent.cmd"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " CloudOps Local Docker Agent Windows Installer" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verify Node.js
Write-Host "▶ Checking Node.js runtime..." -ForegroundColor Yellow
try {
    $nodeVer = (node -v).TrimStart('v')
    $major = [int]($nodeVer.Split('.')[0])
    if ($major -lt 18) {
        Write-Error "Node.js v18.0.0 or higher is required. Detected: v$nodeVer. Please upgrade from https://nodejs.org/"
    }
    Write-Host "✔ Found Node.js v$nodeVer" -ForegroundColor Green
} catch {
    Write-Error "Node.js is not installed or not in PATH. Please install Node.js (v18+) from https://nodejs.org/"
}

# 2. Create Target Directory
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

# 3. Download Agent
$DownloadUrl = "$CloudOpsServer/api/agent/dist/cloudops-agent"
Write-Host "▶ Downloading CloudOps Agent from $DownloadUrl..." -ForegroundColor Yellow
$TempFile = Join-Path $InstallDir "cloudops-agent.tmp"
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempFile -UseBasicParsing

# 4. Verify Checksum
if ($ExpectedSha256 -ne "") {
    Write-Host "▶ Verifying SHA-256 checksum..." -ForegroundColor Yellow
    $actualHash = (Get-FileHash -Path $TempFile -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $ExpectedSha256.ToLower()) {
        Remove-Item -Force $TempFile
        Write-Error "Checksum verification failed! Expected: $ExpectedSha256, Actual: $actualHash"
    }
    Write-Host "✔ SHA-256 Checksum verified: $actualHash" -ForegroundColor Green
}

Move-Item -Force $TempFile $AgentScriptPath

# 5. Create Windows CMD Wrapper
$CmdContent = "@echo off\`r\`nnode \\"%~dp0cloudops-agent.js\\" %*\`r\`n"
[System.IO.File]::WriteAllText($AgentCmdPath, $CmdContent)

# 6. Add to User PATH if missing
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$InstallDir*") {
    $newPath = "$userPath;$InstallDir"
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    $env:PATH = "$env:PATH;$InstallDir"
    Write-Host "✔ Added $InstallDir to User PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "✔ CloudOps Local Agent installed successfully on Windows!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To pair your machine with CloudOps, run in PowerShell/CMD:" -ForegroundColor White
Write-Host "  cloudops-agent connect --code <PAIRING_CODE> --server $CloudOpsServer" -ForegroundColor Green
Write-Host ""
`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(script);
  }
}

module.exports = new DistController();
