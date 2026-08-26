import type { ConfigType } from '@nestjs/config';

import appConfig from '../config/app.config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  const controller = new AuthController(
    {} as AuthService,
    { frontendUrl: 'http://localhost:3001' } as ConfigType<typeof appConfig>,
  );

  it('redirects legacy reset links to the frontend reset page', () => {
    expect(controller.legacyResetPasswordLanding('token123')).toEqual({
      url: 'http://localhost:3001/reset-password?token=token123',
      statusCode: 307,
    });
  });

  it('redirects a legacy link without a token to the frontend reset page', () => {
    expect(controller.legacyResetPasswordLanding()).toEqual({
      url: 'http://localhost:3001/reset-password',
      statusCode: 307,
    });
  });
});
