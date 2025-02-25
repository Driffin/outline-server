// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as process from 'process';
import * as prometheus from 'prom-client';
import * as restify from 'restify';

import {RealClock} from '../infrastructure/clock';
import {PortProvider} from '../infrastructure/get_port';
import * as json_config from '../infrastructure/json_config';
import * as logging from '../infrastructure/logging';
import {PrometheusClient, runPrometheusScraper} from '../infrastructure/prometheus_scraper';
import {AccessKeyId} from '../model/access_key';

import {PrometheusManagerMetrics} from './manager_metrics';
import {bindService, ShadowsocksManagerService} from './manager_service';
import {OutlineShadowsocksServer} from './outline_shadowsocks_server';
import {AccessKeyConfigJson, ServerAccessKeyRepository} from './server_access_key';
import * as server_config from './server_config';
import {OutlineSharedMetricsPublisher, PrometheusUsageMetrics, RestMetricsCollectorClient, SharedMetricsPublisher} from './shared_metrics';

const DEFAULT_STATE_DIR = '/root/shadowbox/persisted-state';
const MMDB_LOCATION = '/var/lib/libmaxminddb/GeoLite2-Country.mmdb';

async function exportPrometheusMetrics(registry: prometheus.Registry, port): Promise<http.Server> {
  return new Promise<http.Server>((resolve, _) => {
    const server = http.createServer((_, res) => {
      res.write(registry.metrics());
      res.end();
    });
    server.on('listening', () => {
      resolve(server);
    });
    server.listen({port, host: 'localhost', exclusive: true});
  });
}

function reserveExistingAccessKeyPorts(
    keyConfig: json_config.JsonConfig<AccessKeyConfigJson>, portProvider: PortProvider) {
  const accessKeys = keyConfig.data().accessKeys || [];
  const dedupedPorts = new Set(accessKeys.map(ak => ak.port));
  dedupedPorts.forEach(p => portProvider.addReservedPort(p));
}

async function main() {
  const verbose = process.env.LOG_LEVEL === 'debug';
  const portProvider = new PortProvider();
  const accessKeyConfig = json_config.loadFileConfig<AccessKeyConfigJson>(
      getPersistentFilename('shadowbox_config.json'));
  reserveExistingAccessKeyPorts(accessKeyConfig, portProvider);

  prometheus.collectDefaultMetrics({register: prometheus.register});

  // Default to production metrics, as some old Docker images may not have
  // SB_METRICS_URL properly set.
  const metricsCollectorUrl = process.env.SB_METRICS_URL || 'https://metrics-prod.uproxy.org';
  if (!process.env.SB_METRICS_URL) {
    logging.warn('process.env.SB_METRICS_URL not set, using default');
  }

  const DEFAULT_PORT = 8081;
  const apiPortNumber = Number(process.env.SB_API_PORT || DEFAULT_PORT);
  if (isNaN(apiPortNumber)) {
    logging.error(`Invalid SB_API_PORT: ${process.env.SB_API_PORT}`);
    process.exit(1);
  }
  portProvider.addReservedPort(apiPortNumber);

  const serverConfig =
      server_config.readServerConfig(getPersistentFilename('shadowbox_server_config.json'));

  const proxyHostname = serverConfig.data().hostname;
  if (!proxyHostname) {
    logging.error('Need to specify hostname in shadowbox_server_config.json');
    process.exit(1);
  }

  logging.debug(`=== Config ===`);
  logging.debug(`Hostname: ${proxyHostname}`);
  logging.debug(`SB_METRICS_URL: ${metricsCollectorUrl}`);
  logging.debug(`==============`);

  logging.info('Starting...');

  const prometheusPort = await portProvider.reserveFirstFreePort(9090);
  // Use 127.0.0.1 instead of localhost for Prometheus because it's resolving incorrectly for some users.
  // See https://github.com/Jigsaw-Code/outline-server/issues/341
  const prometheusLocation = `127.0.0.1:${prometheusPort}`;

  const nodeMetricsPort = await portProvider.reserveFirstFreePort(prometheusPort + 1);
  exportPrometheusMetrics(prometheus.register, nodeMetricsPort);
  const nodeMetricsLocation = `127.0.0.1:${nodeMetricsPort}`;

  const ssMetricsPort = await portProvider.reserveFirstFreePort(nodeMetricsPort + 1);
  logging.info(`Prometheus is at ${prometheusLocation}`);
  logging.info(`Node metrics is at ${nodeMetricsLocation}`);

  const prometheusConfigJson = {
    global: {
      scrape_interval: '15s',
    },
    scrape_configs: [
      {job_name: 'prometheus', static_configs: [{targets: [prometheusLocation]}]},
      {job_name: 'outline-server-main', static_configs: [{targets: [nodeMetricsLocation]}]},
    ]
  };

  const ssMetricsLocation = `127.0.0.1:${ssMetricsPort}`;
  logging.info(`outline-ss-server metrics is at ${ssMetricsLocation}`);
  prometheusConfigJson.scrape_configs.push(
      {job_name: 'outline-server-ss', static_configs: [{targets: [ssMetricsLocation]}]});
  const shadowsocksServer =
      new OutlineShadowsocksServer(
          getPersistentFilename('outline-ss-server/config.yml'), verbose, ssMetricsLocation)
          .enableCountryMetrics(MMDB_LOCATION);
  const prometheusEndpoint = `http://${prometheusLocation}`;
  // Wait for Prometheus to be up and running.
  await runPrometheusScraper(
      [
        '--storage.tsdb.retention', '31d', '--storage.tsdb.path',
        getPersistentFilename('prometheus/data'), '--web.listen-address', prometheusLocation,
        '--log.level', verbose ? 'debug' : 'info'
      ],
      getPersistentFilename('prometheus/config.yml'), prometheusConfigJson, prometheusEndpoint);

  const prometheusClient = new PrometheusClient(prometheusEndpoint);
  if (!serverConfig.data().portForNewAccessKeys) {
    serverConfig.data().portForNewAccessKeys = await portProvider.reserveNewPort();
    serverConfig.write();
  }
  const accessKeyRepository = new ServerAccessKeyRepository(
      serverConfig.data().portForNewAccessKeys, proxyHostname, accessKeyConfig, shadowsocksServer,
      prometheusClient, serverConfig.data().dataUsageTimeframe);

  const metricsReader = new PrometheusUsageMetrics(prometheusClient);
  const toMetricsId = (id: AccessKeyId) => {
    try {
      return accessKeyRepository.getMetricsId(id);
    } catch (e) {
      logging.warn(`Failed to get metrics id for access key ${id}: ${e}`);
    }
  };
  const managerMetrics = new PrometheusManagerMetrics(prometheusClient);
  const metricsCollector = new RestMetricsCollectorClient(metricsCollectorUrl);
  const metricsPublisher: SharedMetricsPublisher = new OutlineSharedMetricsPublisher(
      new RealClock(), serverConfig, metricsReader, toMetricsId, metricsCollector);
  const managerService = new ShadowsocksManagerService(
      process.env.SB_DEFAULT_SERVER_NAME || 'Outline Server', serverConfig, accessKeyRepository,
      managerMetrics, metricsPublisher);

  const certificateFilename = process.env.SB_CERTIFICATE_FILE;
  const privateKeyFilename = process.env.SB_PRIVATE_KEY_FILE;
  const apiServer = restify.createServer({
    certificate: fs.readFileSync(certificateFilename),
    key: fs.readFileSync(privateKeyFilename)
  });

  // Pre-routing handlers
  apiServer.pre(restify.CORS());

  // All routes handlers
  const apiPrefix = process.env.SB_API_PREFIX ? `/${process.env.SB_API_PREFIX}` : '';
  apiServer.pre(restify.pre.sanitizePath());
  apiServer.use(restify.jsonp());
  apiServer.use(restify.bodyParser());
  bindService(apiServer, apiPrefix, managerService);

  apiServer.listen(apiPortNumber, () => {
    logging.info(`Manager listening at ${apiServer.url}${apiPrefix}`);
  });

  await accessKeyRepository.start(new RealClock());
}

function getPersistentFilename(file: string): string {
  const stateDir = process.env.SB_STATE_DIR || DEFAULT_STATE_DIR;
  return path.join(stateDir, file);
}

process.on('unhandledRejection', (error: Error) => {
  logging.error(`unhandledRejection: ${error.stack}`);
});

main().catch((error) => {
  logging.error(error.stack);
  process.exit(1);
});
