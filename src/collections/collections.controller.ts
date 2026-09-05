import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CollectionsService } from './collections.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';

class CreateCollectionDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  coverUrl?: string;
}

class AddItemDto {
  @IsString()
  itemId: string;
}

@ApiTags('collections')
@ApiBearerAuth()
@Controller('collections')
@UseGuards(JwtAuthGuard)
export class CollectionsController {
  constructor(private collections: CollectionsService) {}

  @ApiOperation({ summary: 'List my portfolio collections' })
  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.collections.listForUser(userId);
  }

  @ApiOperation({ summary: 'Create a portfolio collection (campaign)' })
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateCollectionDto) {
    return this.collections.create(userId, dto);
  }

  @ApiOperation({ summary: 'Add a portfolio item to a collection' })
  @Post(':id/items')
  addItem(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AddItemDto) {
    return this.collections.addItem(userId, id, dto.itemId);
  }

  @ApiOperation({ summary: 'Delete a collection (detaches items)' })
  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.collections.remove(userId, id);
  }
}
