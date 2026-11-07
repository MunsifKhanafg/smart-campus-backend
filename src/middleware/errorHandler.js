import { ApiError } from '../utils/apiHelpers.js';

export const notFound = (req, _res, next) => next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));

export const errorHandler = (err, _req, res, _next) => {
  let status = err.statusCode || 500;
  let message = err.message || 'Server error';
  let details = err.details;

  if (err.name === 'ValidationError' && err.errors) {
    status = 400;
    message = 'Validation failed';
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
  } else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    message = `A record with this ${field} already exists`;
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if (err.name === 'MulterError') {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message;
  }

  if (status >= 500) {
    console.error(err);
    if (process.env.NODE_ENV === 'production') message = 'Internal server error';
  }

  res.status(status).json({ success: false, message, details });
};
