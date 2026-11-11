// What kind of picture is in these bytes? Looks at the first bytes of the file (the "magic number") instead of trusting the file name or the
// type the browser claims, so a renamed document or program can never be stored as a photo. Pure code: unit tested.
export const sniffImage = (buf) => {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
};

export const MAX_PHOTO_BYTES = 300 * 1024; // the page shrinks pictures to about 320 x 320 pixels first (20 to 40 KB)
