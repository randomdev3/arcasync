import type { Logger } from "pino";
import { pino } from "pino";

export type { Logger };

export function createLogger(opts: { level: string; format: "json" | "pretty" }): Logger {
	if (opts.format === "pretty") {
		return pino({
			level: opts.level,
			transport: {
				target: "pino-pretty",
				options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
			},
		});
	}
	return pino({ level: opts.level });
}
