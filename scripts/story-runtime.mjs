import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
export const skill = process.env.STORY_SKILL_DIR;
export const runtime = process.env.STORY_RUNTIME_DIR;
if (!skill || !runtime) throw new Error('Run ./scripts/story.sh build to select the bundled runtime.');

// Resolve the exact bundled packages without a project node_modules or npm install.
const require = createRequire(path.join(runtime, 'node', 'package.json'));
export const { Presentation, PresentationFile } = await import(pathToFileURL(require.resolve('@oai/artifact-tool')));
export const { PDFDocument } = await import(pathToFileURL(require.resolve('pdf-lib')));
export const { default: sharp } = await import(pathToFileURL(require.resolve('sharp')));
export const { finalizePresentation, resolvePresentationFont } = await import(
  pathToFileURL(path.join(skill, 'container_tools/artifact_tool_utils.mjs'))
);
export const python = path.join(runtime, 'python/bin/python3');
