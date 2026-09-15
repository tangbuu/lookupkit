import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const active = LEVELS[(config.logLevel as Level) in LEVELS ? (config.logLevel as Level) : 'info'];

function emit(level: Level, msg: string, extra?: unknown): void {
  if (LEVELS[level] < active) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, typeof extra === 'string' ? extra : JSON.stringify(extra));
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
