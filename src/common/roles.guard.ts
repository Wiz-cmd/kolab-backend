import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from './roles.decorator';

/**
 * Authenticates (via JWT) then enforces role-based access control.
 *
 * Extending `JwtAuthGuard` guarantees `req.user` is populated BEFORE we
 * inspect roles, regardless of whether the controller also guards with
 * `JwtAuthGuard`. ADMIN always passes so admins can moderate any resource.
 */
@Injectable()
export class RolesGuard extends JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No role requirement -> let the route-level JwtAuthGuard decide (public
    // routes stay public, protected controllers still enforce auth).
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    // A role is required -> authenticate first (populates req.user), then
    // authorize. Extending JwtAuthGuard guarantees req.user is set.
    const authed = await super.canActivate(context);
    if (!authed) return false;

    const user = context.switchToHttp().getRequest().user;
    if (!user || !user.role) {
      throw new ForbiddenException('Access denied');
    }
    if (user.role === Role.ADMIN) {
      return true;
    }
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Access denied for your role');
    }
    return true;
  }
}
