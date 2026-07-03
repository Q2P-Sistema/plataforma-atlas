import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { loadConfig, createLogger } from '@atlas/core';
import { globalErrorHandler } from './error-handler.js';
import healthRouter from './health.js';
import authRouter from './routes/auth.routes.js';
import adminRouter from './routes/admin.routes.js';
import { registerModuleRoutes } from './modules.js';
import { seedAdmin } from './seed.js';

const config = loadConfig();
const logger = createLogger('api');
const app: express.Express = express();

// Global middleware
// SEG-06: headers de segurança. CSP desligada — a API é JSON-only e o SPA é
// servido pelo nginx (apps/web); helmet antes do cors para cobrir erros/preflight.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);
// SEG-05: allowlist de origem (antes `origin: true` refletia qualquer site com
// credentials). APP_URL cobre dev (localhost:5173), UAT e prod.
app.use(cors({ origin: config.APP_URL, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Routes
app.use(healthRouter);
app.use(authRouter);
app.use(adminRouter);

// Module routes (feature-flag gated)
registerModuleRoutes(app);

// Global error handler (must be last)
app.use(globalErrorHandler);

// Start
app.listen(config.API_PORT, async () => {
  logger.info(
    { port: config.API_PORT, env: config.NODE_ENV },
    'Atlas API started',
  );
  await seedAdmin();
});

export default app;
