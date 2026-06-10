import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(): express.Express {
  const app = express();
  app.use(express.static(publicDir, { extensions: ['html'] }));
  return app;
}

/** Start the demo app; resolves once listening. */
export function startServer(port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(createApp());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        port: boundPort,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = parseInt(process.env.PORT ?? '4173', 10);
  startServer(port).then(({ port: p }) => console.log(`example app on http://localhost:${p}`));
}
