import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DealsService } from './deals.service';
import { Roles } from '../common/roles.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CreateDealDto, RefundDealDto, UpdateDealStatusDto } from './dto/deals.dto';

@ApiTags('deals')
@ApiBearerAuth()
@Controller('deals')
@UseGuards(JwtAuthGuard)
export class DealsController {
  constructor(private dealsService: DealsService) {}

  @ApiOperation({ summary: 'Create a deal (Brand only)' })
  @Post()
  @Roles(Role.BRAND, Role.ADMIN)
  create(@CurrentUser('id') userId: string, @Body() dto: CreateDealDto) {
    return this.dealsService.create(userId, dto);
  }

  @ApiOperation({ summary: 'List my deals (paginated)' })
  @Get()
  findMine(@CurrentUser('id') userId: string, @Query() query: PaginationQueryDto) {
    return this.dealsService.findForUser(userId, { take: query.take, skip: query.skip });
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.dealsService.findById(id, userId);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateDealStatusDto,
  ) {
    return this.dealsService.updateStatus(id, user.id, user.role, dto.status, dto.reason);
  }

  @Post(':id/dispute')
  @HttpCode(HttpStatus.OK)
  dispute(@CurrentUser() user: any, @Param('id') id: string) {
    return this.dealsService.raiseDispute(id, user.id);
  }

  @ApiOperation({ summary: 'Release escrow to creator (Brand/Admin only)' })
  @Post(':id/release')
  @Roles(Role.BRAND, Role.ADMIN)
  release(@CurrentUser() user: any, @Param('id') id: string) {
    return this.dealsService.releaseFunds(id, user.id, user.role);
  }
}

@ApiTags('deals')
@ApiBearerAuth()
@Controller('admin/deals')
@UseGuards(JwtAuthGuard)
@Roles(Role.ADMIN)
export class AdminDealsController {
  constructor(private dealsService: DealsService) {}

  @ApiOperation({ summary: 'Refund escrowed funds to the brand (Admin only)' })
  @Post(':id/refund')
  refund(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: RefundDealDto,
  ) {
    return this.dealsService.refundDeal(id, adminId, dto.reason);
  }
}
