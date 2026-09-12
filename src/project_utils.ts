import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface ExportProjectParams {
  projectPath: string;
  preset: string;
  outputPath: string;
  debug?: boolean;
}

export interface ExportResult {
  success: boolean;
  outputPath: string;
  output: string;
  errors: string[];
}

export interface ExportPreset {
  name: string;
  platform: string;
  runnable: boolean;
  custom_features: string[];
  export_path: string;
}

/**
 * Exports the Godot project using the CLI
 */
export async function exportProject(params: ExportProjectParams, godotPath: string): Promise<ExportResult> {
  const absoluteOutputPath = join(params.projectPath, params.outputPath);
  const flag = params.debug ? '--export-debug' : '--export-release';

  // Construct command
  // "godot" --headless --path "project/path" --export-release "Windows Desktop" "builds/game.exe"
  const cmd = `"${godotPath}" --headless --path "${params.projectPath}" ${flag} "${params.preset}" "${absoluteOutputPath}"`;

  try {
    const { stdout, stderr } = await execAsync(cmd);

    // Check if output file was created
    if (!existsSync(absoluteOutputPath)) {
      return {
        success: false,
        outputPath: absoluteOutputPath,
        output: stdout,
        errors: ['Output file was not created. Check export preset name and permissions.', stderr],
      };
    }

    return {
      success: true,
      outputPath: absoluteOutputPath,
      output: stdout,
      errors: stderr ? [stderr] : [],
    };
  } catch (error) {
    // execAsync rejects with an Error carrying the child's captured streams, so both are
    // worth reporting: the stderr is usually the only thing that says why the export failed.
    const failure = error as Error & { stdout?: string; stderr?: string };
    return {
      success: false,
      outputPath: absoluteOutputPath,
      output: failure.stdout ?? '',
      errors: [failure.message, failure.stderr ?? ''],
    };
  }
}

/**
 * Everything after the first `=` on a config line. Splitting on every `=` and taking the
 * second field truncates any value that contains one, which an export path readily does.
 */
function configValue(line: string): string {
  const separator = line.indexOf('=');
  return separator === -1 ? '' : line.slice(separator + 1);
}

function unquoted(line: string): string {
  return configValue(line).replace(/"/g, '');
}

/**
 * Parses export_presets.cfg to list available presets
 */
export function listExportPresets(projectPath: string): ExportPreset[] {
  const configPath = join(projectPath, 'export_presets.cfg');
  if (!existsSync(configPath)) {
    return [];
  }

  const content = readFileSync(configPath, 'utf-8');
  const presets: ExportPreset[] = [];

  const lines = content.split('\n');
  let currentPreset: Partial<ExportPreset> | null = null;

  for (const line of lines) {
    if (line.startsWith('[preset.')) {
      if (currentPreset?.name) {
        presets.push(currentPreset as ExportPreset);
      }
      currentPreset = { custom_features: [] };
    } else if (line.startsWith('name=')) {
      if (currentPreset) currentPreset.name = unquoted(line);
    } else if (line.startsWith('platform=')) {
      if (currentPreset) currentPreset.platform = unquoted(line);
    } else if (line.startsWith('runnable=')) {
      if (currentPreset) currentPreset.runnable = configValue(line) === 'true';
    } else if (line.startsWith('export_path=')) {
      if (currentPreset) currentPreset.export_path = unquoted(line);
    }
  }

  if (currentPreset?.name) {
    presets.push(currentPreset as ExportPreset);
  }

  return presets;
}
