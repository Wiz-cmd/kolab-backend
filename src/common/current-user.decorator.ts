import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Injects the authenticated user (populated by JwtAuthGuard) into a handler.
 *
 * @example
 *   update(@CurrentUser() user: User) { ... }
 *   // or a single property:
 *   update(@CurrentUser('id') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
