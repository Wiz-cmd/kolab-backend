import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContractsService } from './contracts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

@ApiTags('contracts')
@ApiBearerAuth()
@Controller('contracts')
@UseGuards(JwtAuthGuard)
export class ContractsController {
  constructor(private contracts: ContractsService) {}

  /** Generate (or refresh) and store the contract PDF for a deal. */
  @Post('deals/:dealId')
  @ApiOperation({ summary: 'Generate & store the contract PDF for a deal' })
  generate(@Param('dealId') dealId: string, @CurrentUser('id') actorId: string) {
    return this.contracts.generateContract(dealId, actorId);
  }

  /** Fetch the stored contract for a deal. */
  @Get('deals/:dealId')
  @ApiOperation({ summary: 'Get the contract for a deal' })
  get(@Param('dealId') dealId: string, @CurrentUser('id') requesterId: string) {
    return this.contracts.getContract(dealId, requesterId);
  }
}
