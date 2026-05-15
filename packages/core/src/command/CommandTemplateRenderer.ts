export interface RenderContext {
  variables?: Record<string, string>;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderCommandTemplate(template: string, ctx: RenderContext = {}): string {
  const vars = ctx.variables ?? {};
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return vars[name] ?? "";
    }
    return `{{${name}}}`;
  });
}
