import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Populates `request.user` when a valid bearer token is present but never
 * rejects anonymous callers. Used for public actions that still want to record
 * engagement for signed-in users (for example viewing a Frame).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(_err: unknown, user: TUser | false): TUser {
    // Never reject anonymous callers; a missing/invalid token simply means
    // there is no user attached to the request.
    return (user || null) as TUser;
  }
}
