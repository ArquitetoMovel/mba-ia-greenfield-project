import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from '../exceptions/domain.exception';

@Catch(DomainException)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    response
      .status(exception.httpStatus)
      .setHeader('Content-Type', 'application/json')
      .json({
        statusCode: exception.httpStatus,
        error: exception.errorCode,
        message: exception.message,
      });
  }
}
