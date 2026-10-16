import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import { InventoryClient } from './inventory.client.js';
import { PlaceOrder, OrdersService } from './orders.service.js';

@Controller()
export class OrdersController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(InventoryClient) private readonly inventory: InventoryClient,
  ) {}

  @Post('orders')
  @HttpCode(202)
  async place(
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || key.length > 200) throw new BadRequestException('An Idempotency-Key header (up to 200 characters) is required');
    const parsed = PlaceOrder.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Invalid order', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const { order, replayed } = await this.orders.place(key, parsed.data);
    res.setHeader('Location', `/orders/${order.id}`);
    if (replayed) {
      res.status(200);
      res.setHeader('Idempotent-Replayed', 'true');
    }
    return order;
  }

  @Get('orders/:id')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const order = await this.orders.get(id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancel(id);
  }

  @Get('products')
  async products() {
    try {
      return await this.inventory.listProducts();
    } catch {
      throw new ServiceUnavailableException('Inventory is unavailable');
    }
  }
}
