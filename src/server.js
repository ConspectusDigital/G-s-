import { join } from 'node:path';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || join(process.cwd(), 'data', 'gas.db');

const { server } = createApp({ dbPath });
server.listen(port, () => {
  console.log(`Sistema rodando em http://localhost:${port}`);
  console.log(`Banco de dados: ${dbPath}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
