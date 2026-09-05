import { Injectable, LoggerService, Optional } from '@nestjs/common';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured JSON logger. Emits one JSON object per line so it plays nicely with
 * log shipping (CloudWatch, Papertrail, etc.). Falls back to Nest's default
 * when NOT THE structured flag is off.
 */
@Injectable()
export class AppLogger implements LoggerService {
  constructor(
    @Optional() private readonly context = 'App',
    @Optional() private readonly toJson: boolean = true,
  ) {}

  log(message: any, ...optionalParams: any[]) {
    this.write('info', message, optionalParams);
  }
  error(message: any, ...optionalParams: any[]) {
    this.write('error', message, optionalParams);
  }
  warn(message: any, ...optionalParams: any[]) {
    this.write('warn', message, optionalParams);
  }
  debug?(message: any, ...optionalParams: any[]) {
    this.write('debug', message, optionalParams);
  }
  verbose?(message: any, ...optionalParams: any[]) {
    this.write('info', message, optionalParams);
  }
  fatal?(message: any, ...optionalParams: any[]) {
    this.write('error', message, optionalParams);
  }

  setContext(context: string) {
    (this as any).context = context;
  }

  private write(level: LogLevel, message: any, params: any[]) {
    // If the message is itself an error object, unwrap it.
    if (message instanceof Error) {
      message = message.message;
    }

    const meta: any = { ...params };
    // Support `log(msg, { extra })` by merging a trailing object.
    const trace = meta.context || this.context;

    if (!this.toJson) {
      const std = [`[${trace}]`, message];
      if (Object.keys(meta).length) std.push(JSON.stringify(meta));
      // eslint-disable-next-line no-console
      console[level === 'info' ? 'log' : level](...std);
      return;
    }

    const line = JSON.stringify({
      level,
      ts: new Date().toISOString(),
      context: trace,
      msg: message,
      ...(Object.keys(meta).length ? { meta } : {}),
    });
    // eslint-disable-next-line no-console
    console[level === 'info' ? 'log' : level](line);
  }
}
