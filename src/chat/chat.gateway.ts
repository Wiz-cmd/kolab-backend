import {
  WebSocketGateway,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from './chat.service';
import { jwtSecret } from '../auth/jwt-secret';
import { corsOriginOption } from '../common/cors-origins';

interface JwtUser {
  sub: string;
  email: string;
  role: string;
}

@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: corsOriginOption(), credentials: true },
  maxHttpBufferSize: 1_000_000, // reject oversized socket payloads
  pingInterval: 25_000,
  pingTimeout: 20_000,
})
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  private readonly signingSecret: string;

  constructor(
    private chat: ChatService,
    private prisma: PrismaService,
    private jwt: JwtService,
    config: ConfigService,
  ) {
    // Throws in production when JWT_SECRET is missing/weak (see jwt-secret).
    this.signingSecret = jwtSecret(config);
  }

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      const payload = await this.jwt.verifyAsync<JwtUser>(token, {
        secret: this.signingSecret,
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, isBanned: true },
      });
      if (!user || user.isBanned) throw new UnauthorizedException();

      (client as any).userId = user.id;
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('joinDeal')
  async handleJoin(@MessageBody() data: { dealId: string }, @ConnectedSocket() client: Socket) {
    const userId = (client as any).userId;
    await this.chat.assertDealParticipant(data.dealId, userId);
    await client.join(`deal:${data.dealId}`);
    // Mark previously sent messages as read.
    await this.chat.markDealRead(data.dealId, userId);
    return { event: 'joined', dealId: data.dealId };
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() data: { dealId: string; content: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = (client as any).userId;
    const message = await this.chat.saveMessage(userId, data.content, data.dealId);
    this.server.to(`deal:${data.dealId}`).emit('newMessage', message);
    return message;
  }

  @SubscribeMessage('markRead')
  async handleMarkRead(@MessageBody() data: { dealId: string }, @ConnectedSocket() client: Socket) {
    const userId = (client as any).userId;
    await this.chat.markDealRead(data.dealId, userId);
    this.server.to(`deal:${data.dealId}`).emit('readReceipt', { dealId: data.dealId, readerId: userId });
    return { ok: true };
  }

  private extractToken(client: Socket): string {
    const auth = client.handshake.auth as any;
    if (auth?.token) return auth.token;
    const header = client.handshake.headers?.authorization as string | undefined;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    throw new UnauthorizedException();
  }
}
