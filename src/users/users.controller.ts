import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { IsOptional, IsString, IsUrl, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  bio?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  rate?: string;

  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @IsOptional()
  measurements?: Record<string, any>;

  // E2EE chat public key (SPKI base64). Public by design.
  @IsOptional()
  @IsString()
  publicKey?: string;
}

class PortfolioItemDto {
  @IsUrl()
  imageUrl: string;

  @IsOptional()
  @IsString()
  caption?: string;
}

@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  findAll(@Query() query: ListUsersQueryDto) {
    return this.usersService.findMany({
      role: query.role,
      location: query.location,
      search: query.search,
      take: query.take,
      skip: query.skip,
    });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  getMe(@CurrentUser('id') id: string) {
    return this.usersService.findMe(id);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(@CurrentUser('id') id: string, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(id, dto);
  }

  @Post('me/portfolio')
  @UseGuards(JwtAuthGuard)
  addPortfolio(@CurrentUser('id') id: string, @Body() dto: PortfolioItemDto) {
    return this.usersService.addPortfolioItem(id, dto.imageUrl, dto.caption);
  }

  @Post(':id/follow')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  follow(@CurrentUser('id') meId: string, @Param('id') id: string) {
    return this.usersService.follow(meId, id);
  }

  @Delete(':id/follow')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  unfollow(@CurrentUser('id') meId: string, @Param('id') id: string) {
    return this.usersService.unfollow(meId, id);
  }

  @Get(':id/followers')
  followers(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.usersService.followers(id, { take: query.take, skip: query.skip });
  }

  @Get(':id/following')
  following(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.usersService.following(id, { take: query.take, skip: query.skip });
  }
}
