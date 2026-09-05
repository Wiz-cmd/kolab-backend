import {
  Body,
  Controller,
  Get,
  Header,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private payments: PaymentsService) {}

  /**
   * PayFast posts urlencoded form data here. Respond with a plain 'OK' (no
   * JSON) so the provider's retry logic is satisfied. Idempotency is handled
   * inside the service so retries are safe.
   */
  @Post('webhook/payfast')
  @Header('Content-Type', 'text/plain')
  async payfastWebhook(@Body() payload: Record<string, any>) {
    try {
      const handled = await this.payments.handlePayFastWebhook(payload);
      return handled ? 'OK' : 'ERROR';
    } catch (e: any) {
      this.logger.error(`PayFast webhook rejected: ${e.message}`);
      // Returning non-OK signals PayFast to retry later.
      return 'ERROR';
    }
  }

  /** Brand-initiated: build the PayFast redirect to fund a deal. */
  @Get('payfast/fund/:dealId')
  @ApiOperation({ summary: 'Build a PayFast funding redirect (Brand)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  fundDeal(@CurrentUser('id') userId: string, @Param('dealId') dealId: string) {
    return this.payments.buildPayFastRedirect(dealId, userId);
  }

  /** Brand-initiated: build an Ozow checkout (second rail). */
  @Get('ozow/fund/:dealId')
  @ApiOperation({ summary: 'Build an Ozow checkout (Brand)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  fundDealOzow(@CurrentUser('id') userId: string, @Param('dealId') dealId: string) {
    return this.payments.buildOzowRedirect(dealId, userId);
  }

  /**
   * Ozow payment notification. Ozow sends a webhook and expects an "OK" reply.
   * Signature + idempotency are handled in the service.
   */
  @Post('webhook/ozow')
  @Header('Content-Type', 'text/plain')
  async ozowWebhook(@Body() payload: Record<string, any>) {
    try {
      const handled = await this.payments.handleOzowWebhook(payload);
      return handled ? 'OK' : 'ERROR';
    } catch (e: any) {
      this.logger.error(`Ozow webhook rejected: ${e.message}`);
      return 'ERROR';
    }
  }

  @Get('return')
  return(@Query('deal') deal: string) {
    return { status: 'returned', deal };
  }

  @Get('cancel')
  cancel(@Query('deal') deal: string) {
    return { status: 'cancelled', deal };
  }
}
