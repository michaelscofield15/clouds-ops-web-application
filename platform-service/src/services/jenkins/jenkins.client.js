const config = require('../../config');

class JenkinsClient {
  constructor(baseUrl, username, apiToken) {
    this.baseUrl = (baseUrl || config.jenkins.url).replace(/\/+$/, '');
    this.username = username || config.jenkins.username;
    this.apiToken = apiToken || config.jenkins.apiToken;
  }

  /**
   * Helper to format HTTP basic auth header
   */
  _getAuthHeader() {
    if (!this.username || !this.apiToken) {
      return {};
    }
    const creds = Buffer.from(`${this.username}:${this.apiToken}`).toString('base64');
    return { 'Authorization': `Basic ${creds}` };
  }

  /**
   * Fetches Jenkins CSRF Crumb and Session Cookie
   */
  async getCrumb() {
    try {
      const response = await fetch(`${this.baseUrl}/crumbIssuer/api/json`, {
        headers: { ...this._getAuthHeader() },
        signal: AbortSignal.timeout(3000)
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const setCookie = response.headers.get('set-cookie');
      return {
        crumb: data.crumb,
        crumbField: data.crumbRequestField,
        cookie: setCookie ? setCookie.split(';')[0] : null
      };
    } catch {
      return null;
    }
  }

  /**
   * Performs authenticated request with CSRF handling
   */
  async _request(path, options = {}) {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = {
      ...this._getAuthHeader(),
      ...(options.headers || {})
    };

    if (options.method && options.method !== 'GET') {
      const crumbInfo = await this.getCrumb();
      if (crumbInfo && crumbInfo.crumb && crumbInfo.crumbField) {
        headers[crumbInfo.crumbField] = crumbInfo.crumb;
        if (crumbInfo.cookie) {
          headers['Cookie'] = crumbInfo.cookie;
        }
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 6000);

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    return response;
  }

  /**
   * Checks Jenkins server status and version
   */
  async getStatus() {
    if (this._cachedStatus && (Date.now() - (this._cachedStatusTime || 0) < 15000)) {
      return this._cachedStatus;
    }
    try {
      const response = await this._request('/api/json', { timeout: 2000 });
      const version = response.headers.get('x-jenkins') || 'unknown';

      if (!response.ok) {
        const res = {
          connected: false,
          error: `Jenkins returned status ${response.status}: ${response.statusText}`,
          version
        };
        this._cachedStatus = res;
        this._cachedStatusTime = Date.now();
        return res;
      }

      const data = await response.json().catch(() => ({}));
      const res = {
        connected: true,
        version,
        nodeName: data.nodeName || 'master',
        numExecutors: data.numExecutors || 2,
        quietingDown: Boolean(data.quietingDown)
      };
      this._cachedStatus = res;
      this._cachedStatusTime = Date.now();
      return res;
    } catch (err) {
      const res = {
        connected: false,
        error: `Failed to connect to Jenkins at ${this.baseUrl}: ${err.message}`
      };
      this._cachedStatus = res;
      this._cachedStatusTime = Date.now();
      return res;
    }
  }

  /**
   * Builds XML configuration for a Pipeline (workflow-job) pulling from Git SCM
   */
  _buildPipelineJobXml({ gitRepoUrl, branchName = 'main', credentialsId = '', pipelineScript = '' }) {
    if (pipelineScript) {
      // Escape CDATA end marker if present in script
      const safeScript = pipelineScript.replace(/]]>/g, ']]]]><![CDATA[>');
      return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Pipeline job provisioned automatically by Autonomous DevOps Platform</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty/>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script><![CDATA[${safeScript}]]></script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>`;
    }

    const branchSpec = branchName.startsWith('*/') ? branchName : `*/${branchName}`;
    const credsTag = credentialsId ? `<credentialsId>${credentialsId}</credentialsId>` : '';

    return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Pipeline job provisioned automatically by Autonomous DevOps Platform</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <org.jenkinsci.plugins.workflow.job.properties.DisableConcurrentBuildsJobProperty/>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>${gitRepoUrl}</url>
          ${credsTag}
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>${branchSpec}</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
      <doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations>
      <submoduleCfg class="empty-list"/>
      <extensions/>
    </scm>
    <scriptPath>Jenkinsfile</scriptPath>
    <lightweight>true</lightweight>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>`;
  }

  /**
   * Checks if a job exists in Jenkins
   */
  async jobExists(jobName) {
    const response = await this._request(`/job/${encodeURIComponent(jobName)}/api/json`);
    return response.ok;
  }

  /**
   * Creates or updates a Jenkins pipeline job
   */
  async createOrUpdateJob(jobName, { gitRepoUrl, branchName = 'main', credentialsId = '', pipelineScript = '' } = {}) {
    const xml = this._buildPipelineJobXml({ gitRepoUrl, branchName, credentialsId, pipelineScript });
    const exists = await this.jobExists(jobName);

    if (exists) {
      // Update existing job
      const response = await this._request(`/job/${encodeURIComponent(jobName)}/config.xml`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xml
      });

      if (!response.ok) {
        throw new Error(`Failed to update Jenkins job '${jobName}': ${response.statusText}`);
      }

      return {
        jobName,
        action: 'updated',
        url: `${this.baseUrl}/job/${encodeURIComponent(jobName)}/`
      };
    } else {
      // Create new job
      const response = await this._request(`/createItem?name=${encodeURIComponent(jobName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xml
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to create Jenkins job '${jobName}' (${response.status}): ${text || response.statusText}`);
      }

      return {
        jobName,
        action: 'created',
        url: `${this.baseUrl}/job/${encodeURIComponent(jobName)}/`
      };
    }
  }

  /**
   * Triggers a build for the specified job
   */
  async triggerBuild(jobName) {
    const response = await this._request(`/job/${encodeURIComponent(jobName)}/build`, {
      method: 'POST'
    });

    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`Failed to trigger Jenkins build for '${jobName}': HTTP ${response.status} ${response.statusText}`);
    }

    const queueLocation = response.headers.get('location');
    return {
      status: 'triggered',
      jobName,
      queueLocation
    };
  }

  /**
   * Resolves build number from queue location or latest build
   */
  async getLatestBuildNumber(jobName) {
    const response = await this._request(`/job/${encodeURIComponent(jobName)}/api/json`);
    if (!response.ok) return null;

    const data = await response.json();
    return data.lastBuild?.number || data.nextBuildNumber - 1 || null;
  }

  /**
   * Retrieves status and results of a build
   */
  async getBuildInfo(jobName, buildNumber) {
    const response = await this._request(`/job/${encodeURIComponent(jobName)}/${buildNumber}/api/json`);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          jobName,
          buildNumber: parseInt(buildNumber, 10),
          status: 'queued',
          building: true,
          result: null
        };
      }
      throw new Error(`Failed to query build info for '${jobName} #${buildNumber}': ${response.statusText}`);
    }

    const data = await response.json();
    return {
      jobName,
      buildNumber: data.number,
      building: Boolean(data.building),
      result: data.result, // SUCCESS, FAILURE, UNSTABLE, ABORTED, null (while running)
      durationMs: data.duration || 0,
      estimatedDurationMs: data.estimatedDuration || 0,
      timestamp: data.timestamp ? new Date(data.timestamp).toISOString() : null,
      url: data.url
    };
  }

  /**
   * Retrieves raw console logs for a build
   */
  async getBuildLogs(jobName, buildNumber) {
    const response = await this._request(`/job/${encodeURIComponent(jobName)}/${buildNumber}/consoleText`);

    if (!response.ok) {
      if (response.status === 404) {
        return {
          jobName,
          buildNumber,
          logs: 'Build queued / console logs not yet available.'
        };
      }
      throw new Error(`Failed to retrieve console logs: ${response.statusText}`);
    }

    let logs = await response.text();
    // Mask sensitive tokens / credentials
    logs = logs.replace(/https:\/\/[^@]+@/g, 'https://***@');

    return {
      jobName,
      buildNumber: parseInt(buildNumber, 10),
      logs
    };
  }

  /**
   * Deletes a Jenkins job
   */
  async deleteJob(jobName) {
    const response = await this._request(`/job/${encodeURIComponent(jobName)}/doDelete`, {
      method: 'POST'
    });
    return response.ok;
  }

  /**
   * Executes a Groovy script on the Jenkins master (for system configuration)
   */
  async executeScript(script) {
    const response = await this._request('/scriptText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'script=' + encodeURIComponent(script)
    });
    return await response.text();
  }

  /**
   * Provisions or updates a GitHub token credential in the Jenkins Credentials Store
   */
  async ensureGitHubCredentials(credentialsId = 'cloudops-github-token', token) {
    if (!token) return false;
    const groovy = `
import com.cloudbees.plugins.credentials.impl.*
import com.cloudbees.plugins.credentials.*
import com.cloudbees.plugins.credentials.domains.*

def domain = Domain.global()
def store = Jenkins.instance.getExtensionList('com.cloudbees.plugins.credentials.SystemCredentialsProvider')[0].getStore()

def existing = store.getCredentials(domain).find { it.id == '${credentialsId}' }
if (existing != null) {
    store.removeCredentials(domain, existing)
}

def credential = new UsernamePasswordCredentialsImpl(
    CredentialsScope.GLOBAL,
    '${credentialsId}',
    'CloudOps GitHub Access Token',
    'x-access-token',
    '${token}'
)
store.addCredentials(domain, credential)
println 'CREDENTIAL_SAVED'
`;
    const res = await this.executeScript(groovy);
    return res.includes('CREDENTIAL_SAVED');
  }
}

module.exports = new JenkinsClient();
module.exports.JenkinsClient = JenkinsClient;
