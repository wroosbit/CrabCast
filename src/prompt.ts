import * as fs from 'fs';
import * as path from 'path';

/**
 * Loads a workspace type's prompt template and renders `{{KEY}}`-style
 * placeholders. The base directory is the config file's directory — prompt
 * paths belong to the config that names them, not to any repository layout.
 * `URL` is optional caller-supplied metadata like any other variable; the
 * daemon never resolves one.
 */
export class PromptLoader {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  public loadAndRender(templateRelativePath: string, variables: Record<string, string>): string {
    const fullPath = path.resolve(this.baseDir, templateRelativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Prompt template file not found: ${fullPath}`);
    }

    let content = fs.readFileSync(fullPath, 'utf-8');

    for (const [key, value] of Object.entries(variables)) {
      const placeholder = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      content = content.replace(placeholder, value);
    }

    return content;
  }
}
