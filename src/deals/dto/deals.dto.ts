import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { DealStatus } from '@prisma/client';

export class CreateDealDto {
  @IsString()
  @IsNotEmpty()
  creatorId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsNumber()
  @IsPositive()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  deliverables?: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}

export class UpdateDealStatusDto {
  @IsEnum(DealStatus)
  status: DealStatus;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class RefundDealDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
