// Simple logging utility with log levels
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silent';

const levelOrder: Record<Exclude<LogLevel, 'silent'>, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

class LoggerClass {
  private level: LogLevel = 'error';

  setLevel(level: LogLevel) {
    this.level = level;
  }

  private shouldLog(target: Exclude<LogLevel, 'silent'>): boolean {
    if (this.level === 'silent') return false;
    const current = levelOrder[(this.level === 'debug' ? 'debug' : this.level) as Exclude<LogLevel, 'silent'>];
    const targetOrder = levelOrder[target];
    return current >= targetOrder;
  }

  error(...args: any[]) {
    if (this.shouldLog('error')) console.error('[Auth]', ...args);
  }
  warn(...args: any[]) {
    if (this.shouldLog('warn')) console.warn('[Auth]', ...args);
  }
  info(...args: any[]) {
    if (this.shouldLog('info')) console.info('[Auth]', ...args);
  }
  debug(...args: any[]) {
    if (this.shouldLog('debug')) console.debug('[Auth]', ...args);
  }
}

export const Logger = new LoggerClass();

