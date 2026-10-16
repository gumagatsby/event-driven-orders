// Loaded with `node --import` before the app, so instrumentation is in place
// before pg, kafkajs, grpc-js and express are imported.
import { register } from 'node:module';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { GrpcInstrumentation } from '@opentelemetry/instrumentation-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // The app is an ES module; this hook lets instrumentation patch modules it imports.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'orders',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /^\/(healthz|readyz|metrics)/.test(req.url ?? '') }),
      new ExpressInstrumentation(),
      new PgInstrumentation(),
      new GrpcInstrumentation(),
      new KafkaJsInstrumentation(),
    ],
  });
  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown());
}
