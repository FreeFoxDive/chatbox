/**
 * Stored provider fields use `''` for an explicit clear. That must stay empty.
 * Only a missing value falls back to the provider default.
 */
export function providerInputValue(stored: string | undefined, fallback = ''): string {
  return stored ?? fallback
}
