import { config } from './config';
import { createServer } from './server';
import { createCallLogger } from './logging/logger';

const logger = createCallLogger('main', 'main', 'server', config.logLevel);

const { server } = createServer();

server.listen(config.port, () => {
  logger.info('server.started', `Voice Agent server listening on port ${config.port}`, {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    publicWsBaseUrl: config.publicWsBaseUrl,
    audioRecording: config.enableAudioRecording,
  });
});
