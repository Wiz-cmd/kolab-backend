import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SMS delivery abstraction for login verification codes.
 *
 * With no SMS provider configured it logs the message (development/tests).
 * Set SMS_DRIVER=twilio plus SMS_TWILIO_ACCOUNT_SID, SMS_TWILIO_AUTH_TOKEN and
 * SMS_FROM_NUMBER to deliver real texts.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private config: ConfigService) {}

  get configured(): boolean {
    return (
      this.config.get('SMS_DRIVER') === 'twilio' &&
      !!this.config.get('SMS_TWILIO_ACCOUNT_SID') &&
      !!this.config.get('SMS_TWILIO_AUTH_TOKEN') &&
      !!this.config.get('SMS_FROM_NUMBER')
    );
  }

  async sendLoginOtp(to: string, code: string): Promise<{ delivered: boolean }> {
    if (!this.configured) {
      this.logger.warn(`[sms:console] login code for ${this.mask(to)}: ${code}`);
      return { delivered: false };
    }

    const sid = this.config.get('SMS_TWILIO_ACCOUNT_SID');
    const token = this.config.get('SMS_TWILIO_AUTH_TOKEN');
    const from = this.config.get('SMS_FROM_NUMBER');
    const body = new URLSearchParams({
      To: to,
      From: from!,
      Body: `Your Kolab login code is ${code}. It expires in 10 minutes. Never share this code.`,
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SMS delivery failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return { delivered: true };
  }

  mask(value: string): string {
    if (value.includes('@')) {
      const [name, domain] = value.split('@');
      return `${name.slice(0, 2)}***@${domain}`;
    }
    return value.length > 4 ? `${value.slice(0, 2)}***${value.slice(-2)}` : '***';
  }
}
