/**
 * Input Sanitization Utilities
 *
 * Strips HTML tags, script content, and potentially dangerous characters
 * from user-provided text fields. Prisma handles SQL injection via
 * parameterized queries, but we still sanitize to prevent stored XSS
 * and ensure clean data.
 */

/**
 * Strip HTML tags and script content from a string.
 * Preserves plain text content, collapses whitespace.
 */
export function stripHtml(input: string): string {
  return input
    // Remove script/style blocks entirely (content + tags)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Remove all HTML tags
    .replace(/<[^>]*>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    // Remove null bytes
    .replace(/\0/g, '')
    // Collapse excessive whitespace (preserve single newlines)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sanitize a text field: strip HTML and enforce max length.
 * Returns the sanitized string.
 */
export function sanitizeText(input: string, maxLength: number): string {
  const cleaned = stripHtml(input);
  return cleaned.slice(0, maxLength);
}

/**
 * Sanitize all string values in a flat object (one level deep).
 * Useful for metadata/payload objects.
 */
export function sanitizeObject(
  obj: Record<string, unknown>,
  maxStringLength: number = 5000,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeText(value, maxStringLength);
    } else {
      result[key] = value;
    }
  }
  return result;
}
