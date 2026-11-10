import test from 'node:test';
import assert from 'node:assert/strict';
import { detectImageType } from '../src/utils/imageType.js';

const pad = (arr) => Buffer.concat([Buffer.from(arr), Buffer.alloc(16)]);

test('a PNG, a JPEG and a WEBP are recognised by their first bytes', () => {
  assert.equal(detectImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), 'image/png');
  assert.equal(detectImageType(pad([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)])), 'image/webp');
});

test('a renamed program, a script, an SVG or an empty file is refused', () => {
  assert.equal(detectImageType(Buffer.from('MZ\u0090\u0000\u0003\u0000\u0000\u0000\u0004\u0000\u0000\u0000\u00ff\u00ff')), null);
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(detectImageType(Buffer.from('<?php echo 1; ?>        ')), null);
  assert.equal(detectImageType(Buffer.alloc(0)), null);
  assert.equal(detectImageType(null), null);
});

test('a RIFF file that is not WEBP (for example a WAV sound) is refused', () => {
  assert.equal(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(8)])), null);
});
