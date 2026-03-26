/**
 * Custom error classes for the Agora SDK.
 */

export interface AgoraErrorDetails {
  /** HTTP status code */
  status: number;
  /** Machine-readable error code from the API (e.g. "LISTING_NOT_FOUND") */
  code?: string;
  /** Human-readable error message */
  message: string;
  /** Raw response body, if available */
  body?: unknown;
}

/**
 * Base error thrown by all SDK methods when the API returns a non-2xx response.
 */
export class AgoraError extends Error {
  /** HTTP status code */
  readonly status: number;
  /** Machine-readable error code from the API */
  readonly code?: string;
  /** Raw response body */
  readonly body?: unknown;

  constructor(details: AgoraErrorDetails) {
    super(details.message);
    this.name = 'AgoraError';
    this.status = details.status;
    this.code = details.code;
    this.body = details.body;
  }
}

/**
 * Thrown when the request times out or cannot reach the server.
 */
export class AgoraNetworkError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'AgoraNetworkError';
    this.cause = cause;
  }
}

/**
 * Thrown when auth credentials are missing or invalid (401).
 */
export class AgoraAuthError extends AgoraError {
  constructor(details: AgoraErrorDetails) {
    super(details);
    this.name = 'AgoraAuthError';
  }
}

/**
 * Thrown when the agent lacks permission for the action (403).
 */
export class AgoraForbiddenError extends AgoraError {
  constructor(details: AgoraErrorDetails) {
    super(details);
    this.name = 'AgoraForbiddenError';
  }
}

/**
 * Thrown when a resource is not found (404).
 */
export class AgoraNotFoundError extends AgoraError {
  constructor(details: AgoraErrorDetails) {
    super(details);
    this.name = 'AgoraNotFoundError';
  }
}

/**
 * Thrown when rate-limited (429).
 */
export class AgoraRateLimitError extends AgoraError {
  /** Seconds until the rate limit resets, if provided */
  readonly retryAfter?: number;

  constructor(details: AgoraErrorDetails, retryAfter?: number) {
    super(details);
    this.name = 'AgoraRateLimitError';
    this.retryAfter = retryAfter;
  }
}
