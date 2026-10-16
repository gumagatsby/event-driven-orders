import { NestFactory } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { resolve } from 'node:path';
import { AppModule } from './app.module.js';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { httpDuration } from './metrics.js';

async function bootstrap() {
  const pool = createPool(config.databaseUrl);
  const applied = await migrate(pool, resolve(process.cwd(), 'migrations'));
  if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  await pool.end();

  const app = await NestFactory.create(AppModule);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const end = httpDuration.startTimer({ method: req.method });
    // Label by route template, not raw path, so order ids do not explode the series count.
    res.on('finish', () => end({ route: req.route?.path ?? 'unmatched', status: String(res.statusCode) }));
    next();
  });
  app.enableShutdownHooks();
  await app.listen(config.port);
}
await bootstrap();
