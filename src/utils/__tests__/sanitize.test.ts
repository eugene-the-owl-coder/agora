import { describe, it, expect } from 'vitest';
import { stripHtml, sanitizeText, sanitizeObject } from '../sanitize';

describe('stripHtml', () => {
  it('removes simple HTML tags', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello');
    expect(stripHtml('<b>bold</b> and <i>italic</i>')).toBe('bold and italic');
  });

  it('removes script blocks entirely', () => {
    expect(stripHtml('before<script>alert("xss")</script>after')).toBe('beforeafter');
  });

  it('removes style blocks entirely', () => {
    expect(stripHtml('before<style>.x { color: red; }</style>after')).toBe('beforeafter');
  });

  it('decodes common HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#039; &#x27; &#x2F;')).toBe('& < > " \' \' /');
  });

  it('removes null bytes', () => {
    expect(stripHtml('hello\0world')).toBe('helloworld');
  });

  it('collapses excessive whitespace', () => {
    expect(stripHtml('hello    world')).toBe('hello world');
    expect(stripHtml('hello\t\tworld')).toBe('hello world');
  });

  it('collapses excessive newlines but preserves double', () => {
    expect(stripHtml('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims leading and trailing whitespace', () => {
    expect(stripHtml('  hello  ')).toBe('hello');
  });

  it('handles empty string', () => {
    expect(stripHtml('')).toBe('');
  });

  it('handles string with only HTML tags', () => {
    expect(stripHtml('<div><span></span></div>')).toBe('');
  });
});

describe('sanitizeText', () => {
  it('strips HTML and enforces max length', () => {
    expect(sanitizeText('<b>Hello World</b>', 5)).toBe('Hello');
  });

  it('returns full cleaned text when under max length', () => {
    expect(sanitizeText('Hello', 100)).toBe('Hello');
  });

  it('truncates to exact max length', () => {
    const result = sanitizeText('abcdefghij', 5);
    expect(result).toBe('abcde');
    expect(result.length).toBe(5);
  });

  it('handles empty string', () => {
    expect(sanitizeText('', 100)).toBe('');
  });

  it('handles max length of 0', () => {
    expect(sanitizeText('Hello', 0)).toBe('');
  });

  it('strips HTML before truncating', () => {
    // "<b>Hi</b> World" → "Hi World" → truncated to 5 → "Hi Wo"
    expect(sanitizeText('<b>Hi</b> World', 5)).toBe('Hi Wo');
  });
});

describe('sanitizeObject', () => {
  it('sanitizes all string values', () => {
    const input = { name: '<b>Test</b>', count: 42, active: true };
    const result = sanitizeObject(input);
    expect(result.name).toBe('Test');
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
  });

  it('respects custom max string length', () => {
    const input = { name: 'Hello World' };
    const result = sanitizeObject(input, 5);
    expect(result.name).toBe('Hello');
  });

  it('defaults to 5000 max string length', () => {
    const longString = 'a'.repeat(6000);
    const result = sanitizeObject({ text: longString });
    expect((result.text as string).length).toBe(5000);
  });

  it('handles empty object', () => {
    expect(sanitizeObject({})).toEqual({});
  });
});
