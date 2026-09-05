import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DealStatus } from '@prisma/client';

/**
 * Generates and stores a human-readable contract PDF for a deal.
 *
 * Uses `pdfkit` when available. If it is not installed (or generation fails) the
 * method degrades gracefully: it still records a contract record with an
 * `html` preview so the feature never hard-fails the deal flow.
 */
@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
    private config: ConfigService,
    private notifications: NotificationsService,
  ) {}

  async generateContract(dealId: string, actorId: string) {
    const deal = await this.prisma.deal.findUnique({
      where: { id: dealId },
      include: {
        brand: { select: { id: true, name: true, email: true } },
        creator: { select: { id: true, name: true, email: true } },
      },
    });
    if (!deal) throw new NotFoundException('Deal not found');
    if (deal.brandId !== actorId && deal.creatorId !== actorId) {
      throw new BadRequestException('Not a participant of this deal');
    }
    if (
      !(
        [
          DealStatus.PENDING,
          DealStatus.IN_PROGRESS,
          DealStatus.DELIVERED,
          DealStatus.COMPLETED,
        ] as DealStatus[]
      ).includes(deal.status)
    ) {
      throw new BadRequestException('Deal is not in a contractable state');
    }

    const platformName = this.config.get('APP_NAME') || 'Kolab';
    const platformFee = deal.platformFee || 0;
    const creatorNet = deal.creatorAmount ?? deal.amount - platformFee;

    const html = `
      <html><body>
        <h1>Content Collaboration Agreement</h1>
        <p><strong>Platform:</strong> ${platformName}</p>
        <p><strong>Deal:</strong> ${deal.id}</p>
        <p><strong>Title:</strong> ${deal.title || 'Untitled'}</p>
        <p><strong>Brand:</strong> ${deal.brand.name} (${deal.brand.email})</p>
        <p><strong>Creator:</strong> ${deal.creator.name} (${deal.creator.email})</p>
        <p><strong>Amount:</strong> R${deal.amount.toFixed(2)}</p>
        <p><strong>Platform fee:</strong> R${platformFee.toFixed(2)}</p>
        <p><strong>Creator net:</strong> R${creatorNet.toFixed(2)}</p>
        <p><strong>Deliverables:</strong> ${deal.deliverables || 'As agreed'}</p>
        <p><strong>Deadline:</strong> ${deal.deadline ? new Date(deal.deadline).toLocaleDateString() : 'Not set'}</p>
        <p>Funds are held in escrow by ${platformName} and released to the creator on completion.</p>
        <p>Generated: ${new Date().toISOString()}</p>
      </body></html>
    `;

    let contractUrl: string | null = null;
    let storageKey: string | null = null;
    const pdf = this.buildPdf(deal, platformName, platformFee, creatorNet);
    if (pdf) {
      try {
        const key = `contracts/${dealId}-${Date.now()}.pdf`;
        const res = await this.storage.put(key, Buffer.from(pdf), 'application/pdf');
        contractUrl = res.url;
        storageKey = key;
      } catch (e: any) {
        this.logger.warn(`Contract PDF upload failed: ${e.message}`);
      }
    }

    const contract = await this.prisma.contract.upsert({
      where: { dealId },
      create: {
        dealId,
        html,
        contractUrl,
        storageKey,
        generatedBy: actorId,
      },
      update: { contractUrl, storageKey, html, generatedAt: new Date() },
    });

    // Keep the deal metadata in sync.
    if (contractUrl) {
      await this.prisma.deal.update({
        where: { id: dealId },
        data: { contractUrl },
      });
    }

    await this.notifications.create({
      userId: deal.creatorId,
      type: 'deal',
      title: 'Contract generated',
      body: `Your contract for "${deal.title || 'this deal'}" is ready.`,
      entityType: 'contract',
      entityId: contract.id,
    });

    return { ...contract, pdf: contractUrl ? { url: contractUrl, key: storageKey } : null };
  }

  async getContract(dealId: string, requesterId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { dealId },
      include: { deal: true },
    });
    if (!contract) throw new NotFoundException('Contract not generated yet');
    if (
      contract.deal.brandId !== requesterId &&
      contract.deal.creatorId !== requesterId &&
      requesterId !== 'admin'
    ) {
      throw new BadRequestException('Not a participant of this deal');
    }
    return contract;
  }

  /** Build a PDF buffer with pdfkit, or null if the lib is unavailable. */
  private buildPdf(
    deal: any,
    platformName: string,
    platformFee: number,
    creatorNet: number,
  ): Buffer | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));

      doc.fontSize(18).text('Content Collaboration Agreement', { align: 'center' });
      doc.moveDown();
      doc.fontSize(11).text(`Platform: ${platformName}`);
      doc.text(`Deal: ${deal.id}`);
      doc.text(`Title: ${deal.title || 'Untitled'}`);
      doc.moveDown();
      doc.text(`Brand: ${deal.brand.name} (${deal.brand.email})`);
      doc.text(`Creator: ${deal.creator.name} (${deal.creator.email})`);
      doc.moveDown();
      doc.text(`Amount: R${deal.amount.toFixed(2)}`);
      doc.text(`Platform fee: R${platformFee.toFixed(2)}`);
      doc.text(`Creator net: R${creatorNet.toFixed(2)}`);
      doc.moveDown();
      doc.text(`Deliverables: ${deal.deliverables || 'As agreed'}`);
      doc.text(
        `Deadline: ${deal.deadline ? new Date(deal.deadline).toLocaleDateString() : 'Not set'}`,
      );
      doc.moveDown();
      doc.text(
        'Funds are held in escrow by the platform and released to the creator on completion.',
      );
      doc.text(`Generated: ${new Date().toISOString()}`);
      doc.end();

      return Buffer.concat(chunks);
    } catch (e: any) {
      this.logger.warn(`pdfkit unavailable, storing HTML fallback only: ${e.message}`);
      return null;
    }
  }
}
