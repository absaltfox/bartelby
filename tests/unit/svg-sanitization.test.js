'use strict';

const { sanitizeSvgMarkup } = require('../../utils/application-settings');

describe('sanitizeSvgMarkup', () => {
  describe('script injection', () => {
    it('strips <script> blocks', () => {
      const input = '<svg><script>alert(1)</script><circle r="10"/></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('<script>');
      expect(sanitizeSvgMarkup(input, '')).not.toContain('alert(1)');
    });

    it('strips multi-line <script> blocks', () => {
      const input = '<svg><script type="text/javascript">\nfetch("/admin")\n</script></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('fetch');
    });
  });

  describe('CSS injection', () => {
    it('strips <style> blocks', () => {
      const input = '<svg><style>circle { fill: expression(alert(1)) }</style></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('<style>');
      expect(sanitizeSvgMarkup(input, '')).not.toContain('expression');
    });

    it('strips inline style= attributes', () => {
      const input = '<svg><rect style="fill:url(javascript:alert(1))"/></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('style=');
    });
  });

  describe('external resource loading', () => {
    it('strips <use> elements (xlink reference)', () => {
      const input = '<svg><use href="http://evil.com/sprite.svg#icon"/></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('<use');
    });

    it('strips <foreignObject> (HTML injection)', () => {
      const input = '<svg><foreignObject><body onload="alert(1)"/></foreignObject></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('foreignObject');
      expect(sanitizeSvgMarkup(input, '')).not.toContain('onload');
    });
  });

  describe('event handler injection', () => {
    it('strips quoted onclick attributes', () => {
      const input = '<svg><rect onclick="alert(1)" width="10" height="10"/></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('onclick');
    });

    it('strips onmouseover', () => {
      const input = '<svg onmouseover="document.location=\'http://evil.com\'"></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('onmouseover');
    });

    it('strips unquoted event handlers', () => {
      const input = '<svg><rect onload=alert(1)/></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('onload');
    });
  });

  describe('javascript: href injection', () => {
    it('strips href="javascript:..."', () => {
      const input = '<svg><a href="javascript:alert(1)"><text>click</text></a></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('javascript:');
    });

    it('strips xlink:href="javascript:..."', () => {
      const input = '<svg><a xlink:href="javascript:void(0)"><text>x</text></a></svg>';
      expect(sanitizeSvgMarkup(input, '')).not.toContain('javascript:');
    });
  });

  describe('clean SVG passthrough', () => {
    it('preserves legitimate path and shape elements', () => {
      const clean = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="red"/></svg>';
      const result = sanitizeSvgMarkup(clean, '');
      expect(result).toContain('<circle');
      expect(result).toContain('fill="red"');
    });

    it('uses fallback when markup is empty', () => {
      const fallback = '<svg><rect/></svg>';
      expect(sanitizeSvgMarkup('', fallback)).toBe(fallback);
      expect(sanitizeSvgMarkup(null, fallback)).toBe(fallback);
    });
  });
});
