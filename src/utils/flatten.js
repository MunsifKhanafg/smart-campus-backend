// { feePolicy: { currency: 'PKR' } } -> { 'feePolicy.currency': 'PKR' }
// Using dotted paths makes Mongoose update only those keys instead of replacing the whole nested object.
// Arrays and Dates are values, not nested objects. (A Date has no own keys, so treating it as an object would silently drop it.)
export const flatten = (obj, prefix = '') =>
  Object.entries(obj).reduce((acc, [key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) Object.assign(acc, flatten(value, path));
    else acc[path] = value;
    return acc;
  }, {});
