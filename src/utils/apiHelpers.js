export class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
  }
  static badRequest(msg = 'Bad request', details) { return new ApiError(400, msg, details); }
  static unauthorized(msg = 'Not authenticated') { return new ApiError(401, msg); }
  static forbidden(msg = 'You do not have permission to do this') { return new ApiError(403, msg); }
  static notFound(msg = 'Resource not found') { return new ApiError(404, msg); }
  static conflict(msg = 'Conflict') { return new ApiError(409, msg); }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Consistent response envelope: { success, message, data }
export const sendSuccess = (res, data = null, message = 'OK', statusCode = 200) =>
  res.status(statusCode).json({ success: true, message, data });
