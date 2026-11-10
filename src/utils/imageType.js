// Looks at the first bytes of an uploaded image and says what it REALLY is (never trust the name or the type the browser claims).
// Returns 'image/png', 'image/jpeg', 'image/webp', or null when it is not one of those.
export const detectImageType = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};
