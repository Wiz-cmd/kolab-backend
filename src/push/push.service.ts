import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Firebase Cloud Messaging wrapper. Uses firebase-admin to send mobile push.
 *
 * Requires `FIREBASE_SERVICE_ACCOUNT` (a JSON path or inline JSON) or the
 * `GOOGLE_APPLICATION_CREDENTIALS` env var. When Firebase isn't configured this
 * service no-ops so local dev and tests never need credentials.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private messaging: any = null;
  private firebaseApp: any = null;

  constructor(private config: ConfigService) {
    this.init();
  }

  private init() {
    const serviceAccountPath = this.config.get('FIREBASE_SERVICE_ACCOUNT');
    const googleCreds = this.config.get('GOOGLE_APPLICATION_CREDENTIALS');
    if (!serviceAccountPath && !googleCreds) {
      this.logger.warn('Firebase not configured - push notifications disabled.');
      return;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const admin = require('firebase-admin');
      if (admin.apps.length === 0) {
        if (serviceAccountPath) {
          const cred = serviceAccountPath.trim().startsWith('{')
            ? admin.credential.cert(JSON.parse(serviceAccountPath))
            : admin.credential.cert(serviceAccountPath); // path to JSON file
          this.firebaseApp = admin.initializeApp({ credential: cred });
        } else {
          this.firebaseApp = admin.initializeApp();
        }
      } else {
        this.firebaseApp = admin.apps[0];
      }
      this.messaging = admin.messaging(this.firebaseApp);
      this.logger.log('Firebase admin initialised for push.');
    } catch (e: any) {
      this.logger.error('Failed to initialise Firebase: ' + e.message);
    }
  }

  get enabled(): boolean {
    return !!this.messaging;
  }

  /** Send a push to a single token. Resolves { success: boolean }. */
  async sendToToken(
    token: string,
    payload: { title: string; body?: string; data?: Record<string, string> },
  ): Promise<{ success: boolean }> {
    if (!this.messaging) return { success: false };
    try {
      await this.messaging.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });
      return { success: true };
    } catch (e: any) {
      this.logger.warn(`Push failed for token: ${e.message}`);
      return { success: false };
    }
  }

  /** Send a push to all registered tokens for a user, in parallel. */
  async sendToUser(
    userId: string,
    tokens: string[],
    payload: { title: string; body?: string; data?: Record<string, string> },
  ): Promise<{ sent: number; total: number }> {
    const uniq = [...new Set(tokens)];
    if (!uniq.length) return { sent: 0, total: 0 };
    const results = await Promise.all(
      uniq.map((t) => this.sendToToken(t, payload)),
    );
    return { sent: results.filter((r) => r.success).length, total: uniq.length };
  }
}
