/**
 * Minimal {{variable}} template rendering. Variables come from the trigger
 * payload merged with subscriber fields. Unknown variables render as-is so
 * missing data is visible instead of silently blank.
 */
export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? whole : String(value);
  });
}
