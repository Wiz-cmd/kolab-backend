import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsEmail, IsString, MinLength, IsOptional, IsIn } from 'class-validator';
import { Request } from 'express';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TwoFactorService } from './two-factor.service';
import { CurrentUser } from '../common/current-user.decorator';

// Roles the self-service signup may choose. ADMIN (and any future privileged
// role) is deliberately excluded so nobody can register as an admin.
const PUBLIC_SIGNUP_ROLES = [
  Role.CREATOR,
  Role.MODEL,
  Role.PHOTOGRAPHER,
  Role.BRAND,
];

class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsIn(PUBLIC_SIGNUP_ROLES)
  role?: Role;

  @IsOptional()
  @IsString()
  location?: string;
}

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;

  @IsOptional()
  @IsString()
  twoFactorCode?: string;
}

class RefreshDto {
  @IsString()
  refreshToken: string;
}

class LogoutDto {
  @IsString()
  @IsOptional()
  refreshToken?: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

class RequestResetDto {
  @IsEmail()
  email: string;
}

class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}

class VerifyEmailDto {
  @IsString()
  token: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private twoFactor: TwoFactorService,
    private config: ConfigService,
  ) {}

  @ApiOperation({ summary: 'Register a new account' })
  @ApiResponse({ status: 201, description: 'Account created, tokens returned' })
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.authService.register({
      email: dto.email,
      password: dto.password,
      name: dto.name,
      role: dto.role,
      location: dto.location,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  @ApiOperation({ summary: 'Log in' })
  @ApiResponse({ status: 200, description: 'Access + refresh tokens' })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(
      dto.email,
      dto.password,
      dto.twoFactorCode,
      req.ip,
      req.headers['user-agent'],
    );
  }

  @ApiOperation({ summary: 'Rotate an expired access token' })
  @ApiResponse({ status: 200, description: 'New token pair' })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, req.ip, req.headers['user-agent']);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Body() dto: LogoutDto) {
    return dto.refreshToken
      ? this.authService.logout(dto.refreshToken)
      : { success: true };
  }

  @Post('request-password-reset')
  @HttpCode(HttpStatus.OK)
  requestPasswordReset(@Body() dto: RequestResetDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.authService.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/setup')
  @HttpCode(HttpStatus.OK)
  setup2fa(@CurrentUser() user: any) {
    return this.twoFactor.enable(
      this.config.get('APP_NAME') || 'Kolab',
      user?.email,
    );
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/enable')
  @HttpCode(HttpStatus.OK)
  async enable2fa(
    @CurrentUser('id') userId: string,
    @Body() dto: { secret: string; code: string },
  ) {
    const ok = this.twoFactor.verify(dto.secret, dto.code);
    if (!ok) throw new UnauthorizedException('Invalid 2FA code');
    await this.authService.setTwoFactorEnabled(userId, dto.secret, true);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('2fa/disable')
  @HttpCode(HttpStatus.OK)
  async disable2fa(@CurrentUser('id') userId: string, @Body() dto: { code: string }) {
    const user = await this.authService.findById(userId);
    if (!user?.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled');
    }
    const ok = this.twoFactor.verify(user.twoFactorSecret, dto.code);
    if (!ok) throw new UnauthorizedException('Invalid 2FA code');
    await this.authService.setTwoFactorEnabled(userId, null, false);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  verifyEmail(@CurrentUser('id') userId: string, @Body() dto: VerifyEmailDto) {
    return this.authService.verifyEmail(userId, dto.token);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  logoutAll(@CurrentUser('id') userId: string) {
    return this.authService.logoutAll(userId);
  }
}
