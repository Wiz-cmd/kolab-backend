import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MailMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * Email abstraction. Configured for SMTP (works with SendGrid, Mailgun,
 * Postmark via their SMTP endpoints, or any raw SMTP relay).
 *
 * When `SMTP_HOST` is unset the service falls back to logging the email to the
 * console so local development (and automated tests) never need real creds and
 * never actually send mail. Set `MAIL_DRIVER=console` explicitly to force the
 * log-only behaviour in lower environments.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: any = null;

  constructor(private config: ConfigService) {
    const host = this.config.get('SMTP_HOST');
    if (host && this.driver() === 'smtp') {
      this.transporter = this.createTransporter(host);
    } else {
      this.logger.warn('SMTP not configured - emails will be logged, not sent.');
    }
  }

  private driver(): 'smtp' | 'console' {
    const forced = this.config.get('MAIL_DRIVER');
    if (forced === 'smtp' || forced === 'console') return forced;
    return this.config.get('SMTP_HOST') ? 'smtp' : 'console';
  }

  private createTransporter(host: string) {
    // Lazy require so the dependency is only needed when SMTP is used.
    /* eslint-disable @typescript-eslint/no-var-requires */
    const nodemailer = require('nodemailer');
    return nodemailer.createTransport({
      host,
      port: Number(this.config.get('SMTP_PORT') || 587),
      secure: this.config.get('SMTP_SECURE') === 'true',
      auth: {
        user: this.config.get('SMTP_USER'),
        pass: this.config.get('SMTP_PASSWORD'),
      },
    });
  }

  async send(message: MailMessage): Promise<{ delivered: boolean; preview?: string }> {
    if (!this.transporter) {
      this.logger.log(
        `[mail:console] to=${message.to} subject="${message.subject}"\n${message.text || ''}`,
      );
      return { delivered: false };
    }
    const res = await this.transporter.sendMail({
      from: this.config.get('MAIL_FROM') || 'Kolab <no-reply@kolab.co.za>',
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { delivered: true, preview: res?.messageId };
  }

  async sendPasswordReset(to: string, resetUrl: string) {
    return this.send({
      to,
      subject: 'Kolab - Reset your password',
      text: `Reset your password here: ${resetUrl}\nThis link expires in 1 hour.`,
      html: `<p>Click <a href="${resetUrl}">here</a> to reset your password. This link expires in 1 hour.</p>`,
    });
  }

  async sendEmailVerification(to: string, verifyUrl: string) {
    return this.send({
      to,
      subject: 'Kolab - Verify your email',
      text: `Verify your email here: ${verifyUrl}`,
      html: `<p>Click <a href="${verifyUrl}">here</a> to verify your email.</p>`,
    });
  }
}
