export abstract class DomainException extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class EmailAlreadyExistsException extends DomainException {
  constructor() {
    super('EMAIL_ALREADY_EXISTS', 409, 'Email is already registered');
  }
}

export class InvalidCredentialsException extends DomainException {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class EmailNotConfirmedException extends DomainException {
  constructor() {
    super('EMAIL_NOT_CONFIRMED', 403, 'Email address has not been confirmed');
  }
}

export class InvalidTokenException extends DomainException {
  constructor() {
    super('INVALID_TOKEN', 401, 'Token is invalid');
  }
}

export class TokenExpiredException extends DomainException {
  constructor() {
    super('TOKEN_EXPIRED', 401, 'Token has expired');
  }
}

export class TokenReuseDetectedException extends DomainException {
  constructor() {
    super(
      'TOKEN_REUSE_DETECTED',
      401,
      'Token reuse detected — all sessions revoked',
    );
  }
}

export class UploadFileTooLargeException extends DomainException {
  constructor() {
    super('UPLOAD_FILE_TOO_LARGE', 413, 'File exceeds the 10 GB upload limit');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Only video media types are accepted');
  }
}

export class UploadSessionNotFoundException extends DomainException {
  constructor() {
    super('UPLOAD_SESSION_NOT_FOUND', 404, 'Upload session not found');
  }
}

export class UploadSessionNotActiveException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SESSION_NOT_ACTIVE',
      409,
      'Upload session is no longer active',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      422,
      'Upload parts do not match the storage session',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super('VIDEO_ACCESS_DENIED', 403, 'You do not have access to this video');
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video processing is not complete');
  }
}
