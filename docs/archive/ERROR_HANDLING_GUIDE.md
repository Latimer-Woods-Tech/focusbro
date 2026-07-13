# Error Handling Guide

## Purpose
Standardize error logging, try/catch usage, retry semantics, and graceful degradation across the FocusBro codebase.

## Logging Format
- Always include module context: `console.error('[ModuleName] message:', err.message)`
- Use `console.debug` for verbose diagnostics and `console.warn` for recoverable conditions.

## Try/Catch Rules
- Every `await` must be inside a try/catch.
- DOM updates must be wrapped with error boundaries in timer loops.

## Retry Patterns
- Use `withRetry()` for transient operations (network, 5xx).
- Distinguish retryable (5xx, network) vs non-retryable (4xx).

## Promise Rules
- Every `.then()` chain must include `.catch()` that logs context.

## Anti-Patterns
- No empty `catch(e) {}` blocks.
- No misleading success messages after silent failure.

## Validation
- Grep for `catch (` across codebase; each occurrence must include logging with `[ModuleName]`.

(End of ERROR_HANDLING_GUIDE.md)
