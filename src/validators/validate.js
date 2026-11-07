import { z } from 'zod';
import { ApiError } from '../utils/apiHelpers.js';

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

// validate(schema) -> checks req.body (or 'query' / 'params') and replaces it with the cleaned data.
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return next(ApiError.badRequest('Validation failed', details));
  }
  req[source] = result.data;
  next();
};
