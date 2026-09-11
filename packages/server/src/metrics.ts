import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
	name: "teamsync_http_requests_total",
	help: "HTTP requests handled",
	labelNames: ["method", "route", "status"] as const,
	registers: [registry],
});

export const httpDuration = new Histogram({
	name: "teamsync_http_request_duration_seconds",
	help: "HTTP request duration",
	labelNames: ["method", "route"] as const,
	buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
	registers: [registry],
});

export const wsConnections = new Gauge({
	name: "teamsync_ws_connections",
	help: "Open collaboration WebSocket connections",
	registers: [registry],
});

export const docUpdatesAppended = new Counter({
	name: "teamsync_doc_updates_total",
	help: "Yjs updates appended to the update log",
	registers: [registry],
});

export const docCheckpointsWritten = new Counter({
	name: "teamsync_doc_checkpoints_total",
	help: "Document checkpoints written",
	registers: [registry],
});
