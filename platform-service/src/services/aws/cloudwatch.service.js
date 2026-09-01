const awsClient = require('./aws.client');
const config = require('../../config');

/**
 * Service for retrieving real AWS CloudWatch metrics for deployed EC2 infrastructure.
 * Strictly adheres to the real-data principle: NO simulated or fake values.
 */
class CloudWatchService {
  constructor(client = awsClient) {
    this.awsClient = client;
    this.defaultRegion = config.aws.region || 'ap-south-1';
  }

  /**
   * Retrieves metric statistics for a specific EC2 instance and metric name.
   * @param {string} instanceId EC2 instance ID (e.g. i-0e4f06a59698d1afa)
   * @param {string} metricName Metric name (e.g. CPUUtilization, NetworkIn, NetworkOut)
   * @param {object} options Optional time window and statistics
   * @returns {Promise<object>} Formatted metric statistics with real datapoints
   */
  async getEC2MetricStatistics(instanceId, metricName, options = {}) {
    if (!instanceId || typeof instanceId !== 'string' || !instanceId.startsWith('i-')) {
      throw new Error(`Invalid EC2 Instance ID '${instanceId}' for CloudWatch metric query.`);
    }

    const region = options.region || this.defaultRegion;
    const client = this.awsClient.getCloudWatchClient(region);

    // Default time window: past 60 minutes
    const windowMinutes = options.windowMinutes || 60;
    const period = options.period || (windowMinutes <= 180 ? 300 : 900); // 5-minute standard EC2 metric period
    const endTime = options.endTime ? new Date(options.endTime) : new Date();
    const startTime = options.startTime ? new Date(options.startTime) : new Date(endTime.getTime() - windowMinutes * 60 * 1000);

    const statistics = options.statistics || ['Average', 'Maximum', 'Minimum'];
    if (metricName.startsWith('Network') || metricName.startsWith('Disk')) {
      if (!statistics.includes('Sum')) {
        statistics.push('Sum');
      }
    }

    const params = {
      Namespace: 'AWS/EC2',
      MetricName: metricName,
      Dimensions: [
        {
          Name: 'InstanceId',
          Value: instanceId
        }
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: period,
      Statistics: statistics,
      Unit: options.unit || undefined
    };

    try {
      const { GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
      const command = new GetMetricStatisticsCommand(params);
      const response = await client.send(command);
      return this._processMetricResult(metricName, response, {
        instanceId,
        region,
        startTime,
        endTime,
        windowMinutes,
        period
      });
    } catch (err) {
      return {
        instanceId,
        metricName,
        region,
        source: 'AWS CloudWatch',
        status: 'UNAVAILABLE',
        error: err.message || 'Failed to query CloudWatch metric statistics',
        code: err.name || 'CloudWatchQueryError',
        current: null,
        datapointsCount: 0,
        datapoints: []
      };
    }
  }

  _processMetricResult(metricName, response, options = {}) {
    const rawDatapoints = response.Datapoints || [];
    
    // Sort chronologically ascending
    const sortedDatapoints = rawDatapoints.slice().sort((a, b) => new Date(a.Timestamp) - new Date(b.Timestamp));

    const formattedDatapoints = sortedDatapoints.map((dp) => ({
      timestamp: new Date(dp.Timestamp).toISOString(),
      average: typeof dp.Average === 'number' ? Number(dp.Average.toFixed(2)) : null,
      maximum: typeof dp.Maximum === 'number' ? Number(dp.Maximum.toFixed(2)) : null,
      minimum: typeof dp.Minimum === 'number' ? Number(dp.Minimum.toFixed(2)) : null,
      sum: typeof dp.Sum === 'number' ? Number(dp.Sum.toFixed(2)) : null,
      sampleCount: dp.SampleCount || null,
      unit: dp.Unit || response.Label || 'None'
    }));

    // Determine latest / current datapoint
    const latestDatapoint = formattedDatapoints.length > 0 ? formattedDatapoints[formattedDatapoints.length - 1] : null;
    const hasData = formattedDatapoints.length > 0;

    let averageValue = null;
    if (hasData) {
      const avgSum = formattedDatapoints.reduce((acc, dp) => acc + (dp.average !== null ? dp.average : 0), 0);
      averageValue = Number((avgSum / formattedDatapoints.length).toFixed(2));
    }

    return {
      instanceId: options.instanceId || null,
      name: metricName,
      metricName,
      region: options.region || this.defaultRegion,
      source: 'AWS CloudWatch',
      status: hasData ? 'AVAILABLE' : 'NO_DATA',
      unit: latestDatapoint ? latestDatapoint.unit : (metricName === 'CPUUtilization' ? 'Percent' : 'Bytes'),
      value: latestDatapoint ? (latestDatapoint.average !== null ? latestDatapoint.average : latestDatapoint.maximum) : null,
      current: latestDatapoint ? (latestDatapoint.average !== null ? latestDatapoint.average : latestDatapoint.maximum) : null,
      average: averageValue,
      currentMax: latestDatapoint ? latestDatapoint.maximum : null,
      lastUpdated: latestDatapoint ? latestDatapoint.timestamp : null,
      datapointsCount: formattedDatapoints.length,
      datapoints: formattedDatapoints,
      timeWindow: options.startTime ? {
        start: options.startTime.toISOString(),
        end: options.endTime.toISOString(),
        windowMinutes: options.windowMinutes,
        periodSeconds: options.period
      } : null
    };
  }

  /**
   * Retrieves all standard EC2 metrics (CPU, Network In/Out, Disk Read/Write)
   * @param {string} instanceId EC2 instance ID
   * @param {object} options Optional time window / region
   * @returns {Promise<object>} Combined metrics summary
   */
  async getAllEC2Metrics(instanceId, options = {}) {
    const [cpu, networkIn, networkOut, diskReadOps, diskWriteOps] = await Promise.all([
      this.getEC2MetricStatistics(instanceId, 'CPUUtilization', { ...options, unit: 'Percent' }),
      this.getEC2MetricStatistics(instanceId, 'NetworkIn', { ...options, unit: 'Bytes' }),
      this.getEC2MetricStatistics(instanceId, 'NetworkOut', { ...options, unit: 'Bytes' }),
      this.getEC2MetricStatistics(instanceId, 'DiskReadOps', { ...options, unit: 'Count' }),
      this.getEC2MetricStatistics(instanceId, 'DiskWriteOps', { ...options, unit: 'Count' })
    ]);

    return {
      instanceId,
      region: options.region || this.defaultRegion,
      source: 'AWS CloudWatch',
      timestamp: new Date().toISOString(),
      cpu: {
        metric: 'CPUUtilization',
        source: 'AWS CloudWatch',
        status: cpu.status,
        value: cpu.current,
        unit: 'Percent',
        lastUpdated: cpu.lastUpdated,
        datapoints: cpu.datapoints
      },
      network: {
        source: 'AWS CloudWatch',
        networkIn: {
          metric: 'NetworkIn',
          status: networkIn.status,
          value: networkIn.current,
          unit: 'Bytes',
          lastUpdated: networkIn.lastUpdated,
          datapoints: networkIn.datapoints
        },
        networkOut: {
          metric: 'NetworkOut',
          status: networkOut.status,
          value: networkOut.current,
          unit: 'Bytes',
          lastUpdated: networkOut.lastUpdated,
          datapoints: networkOut.datapoints
        }
      },
      diskOps: {
        source: 'AWS CloudWatch',
        readOps: {
          metric: 'DiskReadOps',
          status: diskReadOps.status,
          value: diskReadOps.current,
          unit: 'Count',
          datapoints: diskReadOps.datapoints
        },
        writeOps: {
          metric: 'DiskWriteOps',
          status: diskWriteOps.status,
          value: diskWriteOps.current,
          unit: 'Count',
          datapoints: diskWriteOps.datapoints
        }
      }
    };
  }
}

module.exports = new CloudWatchService();
module.exports.CloudWatchService = CloudWatchService;
