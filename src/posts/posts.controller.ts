import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PostsService } from './posts.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { CreatePostDto } from './dto/create-post.dto';
import { ListPostsQueryDto } from './dto/list-posts-query.dto';

class LimitQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 30;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip = 0;
}

@Controller('posts')
export class PostsController {
  constructor(private postsService: PostsService) {}

  @Get('feed')
  getFeed(@Query() query: ListPostsQueryDto) {
    return this.postsService.findFeed(query.limit, query.skip, {
      search: query.search,
      category: query.category,
      tags: query.tags,
    });
  }

  @Get('feed/for-you')
  @UseGuards(JwtAuthGuard)
  getForYou(@CurrentUser('id') userId: string, @Query() query: ListPostsQueryDto) {
    return this.postsService.findForYouFeed(userId, query.limit);
  }

  @Get('feed/for-you/public')
  getForYouPublic(@Query() query: LimitQueryDto) {
    return this.postsService.findForYouFeed(null, query.limit);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@CurrentUser('id') userId: string, @Body() dto: CreatePostDto) {
    return this.postsService.create(userId, dto);
  }

  @Post(':id/like')
  @UseGuards(JwtAuthGuard)
  like(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.postsService.toggleLike(userId, id);
  }

  @Post(':id/view')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  view(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.postsService.recordView(userId, id);
  }

  @Post(':id/collab-tap')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  collabTap(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.postsService.recordCollabTap(userId, id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  remove(@CurrentUser() user: any, @Param('id') id: string) {
    return this.postsService.deletePost(id, user.id, user.role);
  }

  @Get('interests/me')
  @UseGuards(JwtAuthGuard)
  myInterests(@CurrentUser('id') userId: string) {
    return this.postsService.getUserInterests(userId);
  }
}
