import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Declares which roles may access a route. Combined with {@link RolesGuard}.
 * When no roles are set, `RolesGuard` is a no-op.
 *
 * @example @Roles(Role.BRAND)
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
