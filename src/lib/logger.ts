import pino, { type Logger, type LoggerOptions } from "pino";

type Bindings = Record<string, unknown>;

function shouldPrettyPrint(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.CI) return false;
  return Boolean(process.stdout.isTTY);
}

function resolveLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  // Silence logs under vitest to keep test output clean — override with
  // `LOG_LEVEL=debug bun test` when debugging a failing spec.
  if (process.env.VITEST) return "silent";
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function buildOptions(): LoggerOptions {
  const level = resolveLevel();
  // Skip transport entirely when silent — avoids spinning up the pino-pretty
  // worker thread during tests for nothing.
  if (level === "silent") return { level };
  const transport = shouldPrettyPrint()
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined;
  return { level, transport };
}

export const logger: Logger = pino(buildOptions());

// Every module should call createLogger({ module: "name" }) once at the top
// so all its emissions carry the tag. Pino's built-in `err` serializer handles
// Error objects safely (escapes newlines, captures stack) — this is what lets
// us log `{ err }` without triggering CodeQL's js/log-injection.
export function createLogger(bindings: Bindings): Logger {
  return logger.child(bindings);
}
