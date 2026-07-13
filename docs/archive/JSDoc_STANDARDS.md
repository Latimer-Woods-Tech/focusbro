# JSDoc Standards for FocusBro

## Purpose
Provide a consistent JSDoc template and examples so every public function is documented for IDE tooling and developer clarity.

## Template

```
/**
 * Short one-line summary.
 * Optional longer description.
 *
 * @param {type} name - Description
 * @param {type} [optionalParam] - Description and default
 * @returns {type} Description of return
 * @throws {Error} When something goes wrong
 * @example
 * const result = myFunction(1, 2);
 */
function myFunction(a, b) {}
```

## Rules
- Public functions and helpers must have JSDoc above the declaration.
- Include `@returns`, `@param` and `@throws` where applicable.
- Use `@async` for async functions returning a Promise.
- Provide at least one `@example` for complex functions.

## Frontend examples
- Event handlers, API wrappers, and sync functions must include JSDoc.

## Backend examples
- Route handlers should include `@route`, `@auth`, `@returns` samples.

## Validation Checklist
- Search for `function` declarations and ensure JSDoc exists immediately above.
- 10/10 sampled public functions must have compliant JSDoc.

(End of JSDoc_STANDARDS.md)
